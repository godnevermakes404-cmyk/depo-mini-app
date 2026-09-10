import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import { 
  STATUS_RU, ALLOWED_TRANSITIONS, ON_SITE_STATUSES,
  runDataQualityChecks, calculateLostWagonDays,
  type DQViolation, type RepairTimeMetrics 
} from './depoEngine';
import { 
  notifyWagonsArrivedBulk, notifyActSigned, notifyPositionAssigned, 
  notifyShopStageUpdated, notifyDelayRegistered, notifyStatusChanged 
} from './telegramNotifier';
import './App.css';

declare global { interface Window { Telegram: any; } }

type AppTab = 'home' | 'wagons' | 'warehouse' | 'analytics' | 'profile';

export const CASE_STATUS = {
  PLANNED: '01 PLANNED',
  QUEUE: '04 QUEUE',
  IN_REPAIR: '07 IN_REPAIR',
  PAUSED: '08 REPAIR_PAUSED',
  READY: '11 READY_TO_DISPATCH'
} as const;

const CATEGORY_RU: Record<string, string> = {
  'Materials': '📦 Материалы / Запчасти',
  'Equipment': '🛠 Поломка оборудования',
  'Customer': '👤 Заказчик',
  'Railway': '🚂 Железная дорога (ЖД)'
};

interface Wagon { id?: string; wagon_number: string; owner: string; owner_type: string; }
interface Contract { customer_name: string; sla_hours: number; }
interface RepairCase {
  repair_id: string; current_status: string; repair_type: string; created_at: string;
  sla_deadline: string | null; planned_release: string | null; forecast_release: string | null;
  track_number: string | null; position_number: string | null;
  shop_signatures: Record<string, any>; shop_progress: Record<string, any>; current_shop: string | null;
  contracts: Contract | any; wagons: Wagon | any;
}
interface DelayLog {
  id: string; repair_id: string; category: string; delay_type: string; cause: string;
  responsible_party: string; start_datetime: string; end_datetime: string | null; next_action: string | null;
}
interface ShopMasterConfig { label: string; master: string; tg: string; role: string; targetHours: number; }
interface WarehouseItem { id: string; name: string; category: string; quantity: number; unit: string; min_limit: number; }
interface UserRecord { id: string; name: string; role: string; telegram_id: string; created_at?: string; }

const DOCUMENT_TYPES = ['Справка ВУ 36М', 'АКТ ВУ-23 (Ремонт завершен)', 'АКТ ВУ-22 (Дефектная ведомость)', 'Справка 2612', 'Справка 2602', 'Акт дефектации'];

const DEFAULT_SHOPS = [
  { key: 'bogie', label: 'Тележечный цех' },
  { key: 'wheels', label: 'Колёсный цех' },
  { key: 'brakes', label: 'Автотормозной цех (АКП)' },
  { key: 'body', label: 'Кузовной / Сварочный' },
  { key: 'cooling', label: 'Холодильный цех' },
  { key: 'electric', label: 'Цех электрооборудования' },
  { key: 'prep', label: 'Ремонтно-заготовительный цех' },
  { key: 'mech_equip', label: 'Цех механического оборудования' }
];

const ROLES_LIST = [
  { key: 'ADMIN', label: '👑 Начальник депо (Полный доступ)' },
  { key: 'operator', label: '👨‍💻 Оператор / Диспетчер' },
  { key: 'security', label: '🛡️ Охрана КПП (Приемка вагонов)' },
  { key: 'procurement', label: '📦 Снабжение — Рустамжон' },
  { key: 'mechanic', label: '🛠 Нач. цехов — Абдурахмонжон' },
  { key: 'deputy', label: '👔 Зам. нач. ремонтного цеха' },
  { key: 'otk', label: '🔍 ОТК — Дилявер' },
  { key: 'bogie', label: '🔧 Мастер Тележечного цеха' },
  { key: 'wheels', label: '⚙️ Мастер Колёсного цеха — Сирожиддин' },
  { key: 'brakes', label: '🛑 Мастер Автотормозного цеха (АКП) — Юсупов' },
  { key: 'body', label: '🔨 Мастер Кузовного цеха' },
  { key: 'cooling', label: '❄️ Мастер Холодильного цеха — Алишер' },
  { key: 'electric', label: '⚡ Мастер электрооборудования — Айдер' },
  { key: 'prep', label: '📐 Мастер заготовительного цеха — Ровшан' },
  { key: 'mech_equip', label: '⛓️ Мастер мехоборудования — Шоюнус' },
  { key: 'docs', label: '📄 Оформитель актов (Делопроизводитель)' }
];

export default function App() {
  const [user, setUser] = useState<{ id: string; name: string; role: string; telegram_id?: string } | null>(null);
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [activeRole, setActiveRole] = useState<string>('GUEST');
  const [showAddModal, setShowAddModal] = useState(false);
  const [allUsersList, setAllUsersList] = useState<UserRecord[]>([]);

  // Фильтры вагонов
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [repairTypeFilter, setRepairTypeFilter] = useState<string | null>(null);
  const [delayCategoryFilter, setDelayCategoryFilter] = useState<string | null>(null);

  // Складские состояния
  const [warehouseItems, setWarehouseItems] = useState<WarehouseItem[]>([]);
  const [warehouseSearch, setWarehouseSearch] = useState<string>('');
  const [warehouseCatFilter, setWarehouseCatFilter] = useState<string | null>(null);
  const [showItemModal, setShowItemModal] = useState<boolean>(false);
  const [editingItem, setEditingItem] = useState<WarehouseItem | null>(null);
  const [itemName, setItemName] = useState('');
  const [itemCategory, setItemCategory] = useState('Холодильный цех');
  const [itemQty, setItemQty] = useState('10');
  const [itemUnit, setItemUnit] = useState('шт');
  const [itemMinLimit, setItemMinLimit] = useState('5');

  // Быстрый приход / расход
  const [showStockAdjustModal, setShowStockAdjustModal] = useState<boolean>(false);
  const [adjustingItem, setAdjustingItem] = useState<WarehouseItem | null>(null);
  const [stockDelta, setStockDelta] = useState<string>('10');
  const [adjustMode, setAdjustMode] = useState<'ADD' | 'SUBTRACT'>('ADD');

  const [repairs, setRepairs] = useState<RepairCase[]>([]);
  const [delayLogs, setDelayLogs] = useState<DelayLog[]>([]);
  const [dqViolations, setDqViolations] = useState<DQViolation[]>([]);
  
  const [shopMasters, setShopMasters] = useState<Record<string, ShopMasterConfig>>({
    procurement: { label: 'Отдел снабжения / Закупки', master: 'Рустамжон', tg: '@Rustamjon_5171', role: 'SUPPLY', targetHours: 0 },
    mechanic: { label: 'Начальник цехов', master: 'Абдурахмонжон', tg: '@Abdyraxmonjon', role: 'MECHANIC', targetHours: 0 },
    deputy: { label: 'Зам. начальника ремонтного цеха', master: 'Зам. начальника', tg: '@Smets_1964', role: 'DEPUTY', targetHours: 0 },
    otk: { label: 'ОТК (Отдел технического контроля)', master: 'Дилявер', tg: '@Dilyawer282', role: 'OTK', targetHours: 1 },
    bogie: { label: 'Тележечный цех', master: 'Иванов И.И.', tg: '@master_bogie', role: 'MASTER', targetHours: 4 },
    wheels: { label: 'Колёсный цех', master: 'Сирожиддин', tg: '@Sirojiddin_5171', role: 'MASTER', targetHours: 3 },
    brakes: { label: 'Автотормозной цех (АКП)', master: 'Юсупов', tg: '@Yusupov_75_11', role: 'MASTER', targetHours: 2 },
    body: { label: 'Кузовной / Сварочный цех', master: 'Кузнецов К.К.', tg: '@master_body', role: 'MASTER', targetHours: 5 },
    cooling: { label: 'Холодильный цех', master: 'Алишер', tg: '@master_cooling', role: 'MASTER', targetHours: 4 },
    electric: { label: 'Цех электрооборудования', master: 'Айдер', tg: '@Ayder_1987', role: 'MASTER', targetHours: 3 },
    prep: { label: 'Ремонтно-заготовительный цех', master: 'Ровшан', tg: '@Rovshan_13', role: 'MASTER', targetHours: 3 },
    mech_equip: { label: 'Цех механического оборудования', master: 'Шоюнус', tg: '@Shoyunus_1968', role: 'MASTER', targetHours: 4 },
    docs: { label: 'Оформитель актов (ВУ-22 / ВУ-36М)', master: 'Анна Сергеевна', tg: '@depo_docs_clerk', role: 'CLERK', targetHours: 1 }
  });

  const [selectedCase, setSelectedCase] = useState<RepairCase | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<RepairTimeMetrics | null>(null);
  const [statusHistory, setStatusHistory] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [docType, setDocType] = useState(DOCUMENT_TYPES[0]);
  const [docNumber, setDocNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [isOutsideTelegram, setIsOutsideTelegram] = useState(false);

  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayType, setDelayType] = useState<'PRIMARY' | 'SECONDARY'>('PRIMARY');
  const [delayCause, setDelayCause] = useState('');
  const [responsibleParty, setResponsibleParty] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [actionDeadline, setActionDeadline] = useState('');

  const [arrivalCount, setArrivalCount] = useState<number>(1);
  const [editingWagonNum, setEditingWagonNum] = useState<string>('');

  const [track, setTrack] = useState('Путь 1');
  const [position, setPosition] = useState('Позиция 1');

  const vibrate = (style: 'light' | 'medium' | 'heavy' = 'light') => {
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style); } catch (e) {}
  };

  useEffect(() => { initAuthAndData(); }, []);

  async function initAuthAndData() {
    let tg: any = null;
    let tgUser: any = null;
    try {
      tg = window.Telegram?.WebApp || WebApp;
      if (tg) { 
        tg.ready(); 
        tg.expand(); 
        tg.setHeaderColor?.('bg_main'); 
        tgUser = tg.initDataUnsafe?.user; 
      }
    } catch (e) {}

    const hasTgContext = Boolean(window.Telegram?.WebApp) || Boolean(tg?.initData);
    if (!hasTgContext && !tgUser) { 
      setIsOutsideTelegram(true); 
      return; 
    }

    setIsOutsideTelegram(false);

    if (tgUser?.id) {
      const tgIdStr = String(tgUser.id);
      const fullName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || 'Пользователь';

      const { data: dbUser } = await supabase.from('users').select('*').eq('telegram_id', tgIdStr).maybeSingle();

      if (dbUser) {
        setUser(dbUser); 
        setActiveRole(dbUser.role || 'GUEST');
      } else {
        const { data: newUser } = await supabase
          .from('users')
          .insert([{ telegram_id: tgIdStr, name: fullName, role: 'GUEST' }])
          .select()
          .single();

        if (newUser) {
          setUser(newUser);
          setActiveRole('GUEST');
        } else {
          setUser({ id: 'guest_temp', name: fullName, role: 'GUEST', telegram_id: tgIdStr });
          setActiveRole('GUEST');
        }
      }
    } else {
      const { data: adminUser } = await supabase.from('users').select('*').eq('role', 'ADMIN').limit(1).maybeSingle();
      if (adminUser) {
        setUser(adminUser);
        setActiveRole(adminUser.role || 'ADMIN');
      } else {
        setUser({ id: 'guest_temp', name: 'Гость', role: 'GUEST' });
        setActiveRole('GUEST');
      }
    }
    loadData();
  }

  async function loadData() {
    const { data: repairData } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, sla_deadline, planned_release, forecast_release,
        track_number, position_number, shop_signatures, shop_progress, current_shop,
        contracts ( customer_name, sla_hours ),
        wagons ( id, wagon_number, owner, owner_type )
      `).order('created_at', { ascending: false });

    const { data: delays } = await supabase.from('delay_log').select('*').order('start_datetime', { ascending: false });
    const { data: mastersData } = await supabase.from('shop_masters').select('*');
    const { data: whItems } = await supabase.from('warehouse_items').select('*').order('name', { ascending: true });
    const { data: usersList } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    
    if (usersList) setAllUsersList(usersList as UserRecord[]);

    if (mastersData && mastersData.length > 0) {
      const mapped: Record<string, ShopMasterConfig> = {};
      mastersData.forEach((m: any) => { mapped[m.shop_key] = { label: m.shop_name, master: m.master_name, tg: m.telegram_handle || '@master', role: m.role_code || 'MASTER', targetHours: Number(m.target_hours || 4) }; });
      setShopMasters(prev => ({ ...prev, ...mapped }));
    }

    if (whItems) setWarehouseItems(whItems as WarehouseItem[]);
    if (repairData) {
      setRepairs(repairData as unknown as RepairCase[]);
      setDelayLogs(delays as DelayLog[] || []);
      setDqViolations(runDataQualityChecks(repairData, delays || []));
    }
  }

  const goToWagons = (status: string | null) => {
    vibrate('light');
    setStatusFilter(status);
    setCurrentTab('wagons');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  async function handleRoleChange(newRole: string) { setActiveRole(newRole); vibrate('medium'); }
  
  const isGuest = activeRole === 'GUEST';
  const canPerformAction = (targetShopKey: string) => !isGuest && (activeRole === 'ADMIN' || activeRole === targetShopKey);
  const canManageWarehouse = !isGuest && (activeRole === 'ADMIN' || activeRole === 'procurement');
  const isAdminOrDocs = !isGuest && (activeRole === 'ADMIN' || activeRole === 'docs');
  const isAdminOrOperator = !isGuest && (activeRole === 'ADMIN' || activeRole === 'operator');

  const getMasterLabel = (shopKey: string) => { const info = shopMasters[shopKey]; return info ? `${info.master} (${info.tg})`.trim() : 'Мастер'; };
  const escapeCsvCell = (str: any) => str == null ? '""' : `"${String(str).replace(/"/g, '""')}"`;

  async function handleSaveMasters() {
    setLoading(true); vibrate('heavy');
    for (const [key, val] of Object.entries(shopMasters)) {
      const { error } = await supabase.rpc('update_shop_master', {
        p_shop_key: key, p_shop_name: val.label, p_master_name: val.master, p_tg: val.tg, p_role_code: val.role, p_target_hours: val.targetHours, p_user_id: user?.id || null
      });
      if (error) { alert(`Ошибка сохранения ${val.label}: ` + error.message); }
    }
    alert('Персонал сохранен!'); setLoading(false); loadData();
  }

  async function handleConfirmStockAdjust() {
    if (isGuest || !adjustingItem || !stockDelta.trim()) return;
    const amount = Number(stockDelta);
    if (isNaN(amount) || amount <= 0) { alert('Введите корректное количество!'); return; }

    setLoading(true); vibrate('heavy');
    const finalDelta = adjustMode === 'ADD' ? amount : -amount;

    const { error } = await supabase.rpc('add_warehouse_stock', {
      p_id: adjustingItem.id,
      p_delta: finalDelta,
      p_user_id: user?.id || null
    });

    if (!error) {
      setShowStockAdjustModal(false); setAdjustingItem(null); loadData();
    } else {
      alert('Ошибка изменения остатков: ' + error.message);
    }
    setLoading(false);
  }

  const openStockAdjustModal = (item: WarehouseItem, mode: 'ADD' | 'SUBTRACT') => {
    if (isGuest) return;
    setAdjustingItem(item); setAdjustMode(mode); setStockDelta('10'); setShowStockAdjustModal(true);
  };

  async function handleSaveWarehouseItem() {
    if (isGuest) return;
    if (!itemName.trim()) { alert('Введите наименование позиции!'); return; }
    setLoading(true); vibrate('medium');
    const { error } = await supabase.rpc('save_warehouse_item', {
      p_id: editingItem ? editingItem.id : null,
      p_name: itemName,
      p_category: itemCategory,
      p_quantity: Number(itemQty) || 0,
      p_unit: itemUnit,
      p_min_limit: Number(itemMinLimit) || 0,
      p_user_id: user?.id || null
    });

    if (!error) {
      setShowItemModal(false); setEditingItem(null); setItemName(''); loadData();
    } else {
      alert('Ошибка сохранения склада: ' + error.message);
    }
    setLoading(false);
  }

  const openAddItemModal = (item?: WarehouseItem) => {
    if (isGuest) return;
    if (item) {
      setEditingItem(item); setItemName(item.name); setItemCategory(item.category); setItemQty(String(item.quantity)); setItemUnit(item.unit); setItemMinLimit(String(item.min_limit));
    } else {
      setEditingItem(null); setItemName(''); setItemCategory('Холодильный цех'); setItemQty('10'); setItemUnit('шт'); setItemMinLimit('5');
    }
    setShowItemModal(true);
  };

  async function openCaseDetails(item: RepairCase) {
    vibrate('light'); setSelectedCase(item);
    setEditingWagonNum(item.wagons?.wagon_number?.startsWith('БЕЗ_№_') ? '' : item.wagons?.wagon_number || '');

    const { data: timeMetrics } = await supabase.from('v_repair_time_metrics').select('*').eq('repair_id', item.repair_id).maybeSingle();
    if (timeMetrics) {
      const gross = Math.max(0, Number(timeMetrics.gross_repair_hours || 0));
      const paused = Math.max(0, Number(timeMetrics.paused_hours || 0));
      setSelectedMetrics({
        total_dwell_hours: Number(Number(timeMetrics.total_dwell_hours || 0).toFixed(1)), queue_hours: Number(Number(timeMetrics.queue_hours || 0).toFixed(1)),
        gross_repair_hours: Number(gross.toFixed(1)), paused_hours: Number(paused.toFixed(1)), net_repair_hours: Number(Math.max(0, gross - paused).toFixed(1))
      } as RepairTimeMetrics);
    } else { setSelectedMetrics(null); }

    const { data: events } = await supabase.from('status_events').select('*, users(name, role)').eq('repair_id', item.repair_id).order('event_datetime', { ascending: false });
    if (events) setStatusHistory(events);
    const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', item.repair_id).order('created_at', { ascending: false });
    setDocuments(docs || []);
  }

  async function handleKppArrival() {
    if (isGuest) return;
    if (arrivalCount <= 0) { alert('Укажите количество вагонов!'); return; }

    setLoading(true); vibrate('medium');
    const { error } = await supabase.rpc('register_kpp_arrival', {
      p_count: arrivalCount,
      p_user_id: user?.id || null
    });

    if (!error) {
      notifyWagonsArrivedBulk([], 'ДР', 'Собственный', 'Полувагон');
      alert(`Успешно принято ${arrivalCount} вагонов с КПП! Оператор может внести их реальные номера.`);
      setShowAddModal(false);
      setArrivalCount(1);
      loadData();
    } else {
      alert('Ошибка приёма вагонов с КПП: ' + error.message);
    }
    setLoading(false);
  }

  async function handleSaveWagonNumber() {
    if (!selectedCase?.wagons?.id || !editingWagonNum.trim()) return;
    if (!/^\d{8}$/.test(editingWagonNum.trim())) {
      alert('⚠️ Номер вагона должен состоять ровно из 8 ЦИФР!');
      return;
    }

    setLoading(true); vibrate('medium');
    const { error } = await supabase.rpc('update_wagon_number', {
      p_wagon_id: selectedCase.wagons.id,
      p_new_number: editingWagonNum.trim(),
      p_user_id: user?.id || null
    });

    if (!error) {
      alert('Номер вагона успешно обновлен!');
      setSelectedCase(null);
      loadData();
    } else {
      alert('Ошибка сохранения номера: ' + error.message);
    }
    setLoading(false);
  }

  async function handleDeleteCase() {
    if (activeRole !== 'ADMIN' || !selectedCase) return;
    const wagonNum = selectedCase.wagons?.wagon_number || '';
    if (!window.confirm(`Вы уверены, что хотите полностью удалить вагон №${wagonNum} из базы данных? Это действие нельзя отменить.`)) {
      return;
    }

    setLoading(true); vibrate('heavy');
    const { error } = await supabase.rpc('delete_repair_case', {
      p_repair_id: selectedCase.repair_id,
      p_user_id: user?.id || null
    });

    if (!error) {
      alert(`Вагон успешно удален из базы.`);
      setSelectedCase(null); loadData();
    } else {
      alert('Ошибка удаления вагона: ' + error.message);
    }
    setLoading(false);
  }

  async function handleUploadActPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !selectedCase) return;
    if (!isAdminOrDocs) { alert('⛔ Загружать фото акта может только Оформитель актов или Админ!'); return; }
    setLoading(true); vibrate('medium');

    const fileExt = file.name.split('.').pop() || 'jpg';
    const fileName = `${selectedCase.repair_id}_${Date.now()}.${fileExt}`;
    const filePath = `vu22/${fileName}`;

    const { error: uploadError } = await supabase.storage.from('act_photos').upload(filePath, file, { upsert: true });

    if (uploadError) {
      alert('Ошибка загрузки фото в хранилище: ' + uploadError.message);
      setLoading(false);
      return;
    }

    const { data: urlData } = supabase.storage.from('act_photos').getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    const { error: rpcError } = await supabase.rpc('add_document', {
      p_repair_id: selectedCase.repair_id,
      p_doc_type: 'АКТ ВУ-22 (Дефектная ведомость)',
      p_doc_number: `ВУ-22-${selectedCase.wagons?.wagon_number}`,
      p_user_id: user?.id || null,
      p_file_url: publicUrl
    });

    if (!rpcError) {
      alert('📷 Фото акта ВУ-22 успешно загружено!');
      const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', selectedCase.repair_id).order('created_at', { ascending: false });
      setDocuments(docs || []);
    } else {
      alert('Ошибка сохранения документа: ' + rpcError.message);
    }
    setLoading(false);
  }

  async function handleSignAct(shopKey: string) {
    if (!canPerformAction(shopKey) || !selectedCase) return;
    setLoading(true); vibrate('medium');
    const signLabel = getMasterLabel(shopKey);
    const { data: updatedSigs, error } = await supabase.rpc('sign_defect_act', { 
      p_repair_id: selectedCase.repair_id, 
      p_shop_key: shopKey, 
      p_user_name: signLabel, 
      p_user_id: user?.id || null 
    });

    if (!error) { 
      notifyActSigned(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', signLabel); 
      setSelectedCase({ ...selectedCase, shop_signatures: updatedSigs }); 
      loadData(); 
    } else {
      alert('Ошибка подписи акта: ' + error.message);
    }
    setLoading(false);
  }

  async function handleUpdateShopStage(shopKey: string, status: string) {
    if (!canPerformAction(shopKey) || !selectedCase) return;
    setLoading(true);
    const masterLabel = getMasterLabel(shopKey);
    const { data: updatedProgress, error } = await supabase.rpc('update_shop_stage', { p_repair_id: selectedCase.repair_id, p_shop_key: shopKey, p_status: status, p_master_name: masterLabel, p_user_id: user?.id || null });
    if (!error) { notifyShopStageUpdated(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', status, masterLabel); setSelectedCase({ ...selectedCase, shop_progress: updatedProgress, current_shop: shopKey }); loadData(); }
    setLoading(false);
  }

  async function handleAssignPosition(toRepair: boolean) {
    if (!isAdminOrOperator || !selectedCase) return;
    setLoading(true);
    const { error } = await supabase.rpc('assign_repair_position', { p_repair_id: selectedCase.repair_id, p_track: toRepair ? track : null, p_position: toRepair ? position : null, p_user_id: user?.id || null });
    if (!error) { notifyPositionAssigned(selectedCase.wagons?.wagon_number, toRepair, track, position); setSelectedCase(null); loadData(); }
    else { alert('Ошибка завоза на путь: ' + error.message); }
    setLoading(false);
  }

  async function handleAddDocument() {
    if (!isAdminOrDocs || !docNumber.trim() || !selectedCase) return;
    setLoading(true); vibrate('light');
    const { error } = await supabase.rpc('add_document', { p_repair_id: selectedCase.repair_id, p_doc_type: docType, p_doc_number: docNumber, p_user_id: user?.id || null, p_file_url: null });
    if (!error) { setDocNumber(''); const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', selectedCase.repair_id).order('created_at', { ascending: false }); setDocuments(docs || []); } 
    else { alert('Ошибка: ' + error.message); }
    setLoading(false);
  }

  async function handleUpdateStatus(newStatus: string) {
    if (isGuest || !selectedCase) return;
    if (newStatus === CASE_STATUS.PAUSED) { 
      setDelayCategory('Materials');
      const supplyInfo = shopMasters.procurement;
      setResponsibleParty(supplyInfo ? `${supplyInfo.master} (${supplyInfo.tg})` : 'Отдел снабжения');
      setDelayCause(''); setNextAction(''); setActionDeadline(''); setShowDelayModal(true); return; 
    }
    setLoading(true); vibrate('medium');
    const { error } = await supabase.rpc('change_repair_status', { 
      p_repair_id: selectedCase.repair_id, 
      p_new_status: newStatus,
      p_user_id: user?.id || null, 
      p_comment: `Переход на ${STATUS_RU[newStatus] || newStatus}` 
    });
    if (!error) { notifyStatusChanged(selectedCase.wagons?.wagon_number, STATUS_RU[newStatus] || newStatus); setSelectedCase(null); loadData(); } 
    else { alert('Ошибка: ' + error.message); }
    setLoading(false);
  }

  async function handleConfirmDelay() {
    if (isGuest) return;
    if (!delayCause.trim() || !nextAction.trim() || !responsibleParty.trim()) { alert('Заполните все поля!'); return; }
    setLoading(true); vibrate('heavy');
    const { error } = await supabase.rpc('register_delay', { p_repair_id: selectedCase?.repair_id, p_category: delayCategory, p_delay_type: delayType, p_cause: delayCause, p_responsible_party: responsibleParty, p_next_action: nextAction, p_action_deadline: actionDeadline ? new Date(actionDeadline).toISOString() : null, p_user_id: user?.id || null });
    if (!error) { notifyDelayRegistered(selectedCase?.wagons?.wagon_number || '', delayCategory, delayCause, responsibleParty, nextAction); setShowDelayModal(false); setSelectedCase(null); setActionDeadline(''); loadData(); }
    else { alert('Ошибка задержки: ' + error.message); }
    setLoading(false);
  }

  function exportToCSV() {
    const headers = ['Wagon Number', 'Status', 'Repair Type', 'Owner', 'SLA Deadline', 'Forecast Release'];
    const rows = filteredRepairs.map(r => [ escapeCsvCell(r.wagons?.wagon_number), escapeCsvCell(STATUS_RU[r.current_status] || r.current_status), escapeCsvCell(r.repair_type), escapeCsvCell(r.wagons?.owner), escapeCsvCell(r.sla_deadline ? new Date(r.sla_deadline).toLocaleString() : ''), escapeCsvCell(r.forecast_release ? new Date(r.forecast_release).toLocaleString() : '') ]);
    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const link = document.createElement('a'); link.setAttribute('href', encodeURI(csvContent)); link.setAttribute('download', `depo_wagons_${new Date().toISOString().split('T')[0]}.csv`); document.body.appendChild(link); link.click(); document.body.removeChild(link);
  }

  const onSiteRepairs = repairs.filter(r => ON_SITE_STATUSES.includes(r.current_status));
  
  const filteredRepairs = repairs.filter(r => {
    if (statusFilter && r.current_status !== statusFilter) return false;
    if (repairTypeFilter && r.repair_type !== repairTypeFilter) return false;
    if (searchQuery.trim() && !r.wagons?.wagon_number?.includes(searchQuery.trim())) return false;
    if (delayCategoryFilter) {
      const activeDelay = delayLogs.find(d => d.repair_id === r.repair_id && !d.end_datetime);
      if (!activeDelay || activeDelay.category !== delayCategoryFilter) return false;
    }
    return true;
  });

  const filteredWarehouseItems = warehouseItems.filter(item => {
    if (warehouseCatFilter && item.category !== warehouseCatFilter) return false;
    if (warehouseSearch.trim() && !item.name.toLowerCase().includes(warehouseSearch.trim().toLowerCase())) return false;
    return true;
  });

  const resetAllFilters = () => { setStatusFilter(null); setSearchQuery(''); setRepairTypeFilter(null); setDelayCategoryFilter(null); };
  const isFilterActive = statusFilter || searchQuery || repairTypeFilter || delayCategoryFilter;

  const lostWagonDays = calculateLostWagonDays(delayLogs);
  const readyNotDispatched = repairs.filter(r => r.current_status === CASE_STATUS.READY);
  const forecastBreaches = repairs.filter(r => r.forecast_release && r.sla_deadline && new Date(r.forecast_release) > new Date(r.sla_deadline));
  
  const unassignedWagonsCount = repairs.filter(r => r.wagons?.wagon_number?.startsWith('БЕЗ_№_')).length;

  const getWagonDwellHours = (r: RepairCase) => {
    const start = new Date(r.created_at).getTime();
    const end = r.current_status === CASE_STATUS.READY && r.forecast_release ? new Date(r.forecast_release).getTime() : new Date().getTime();
    return Math.max(0, (end - start) / (1000 * 60 * 60));
  };

  const getRepairTypeStats = (typeCode: string) => {
    const matchingRepairs = repairs.filter(r => r.repair_type === typeCode);
    const hoursList = matchingRepairs.map(getWagonDwellHours);
    if (hoursList.length === 0) return { count: 0, medianHours: 0, medianDays: 0, p90Hours: 0, p90Days: 0 };
    const sorted = [...hoursList].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianH = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const p90Idx = Math.floor(sorted.length * 0.9);
    const p90H = sorted[p90Idx] || sorted[sorted.length - 1];
    return { count: matchingRepairs.length, medianHours: Math.round(medianH), medianDays: Number((medianH / 24).toFixed(1)), p90Hours: Math.round(p90H), p90Days: Number((p90H / 24).toFixed(1)) };
  };

  const drStats = getRepairTypeStats('ДР');
  const krpStats = getRepairTypeStats('КРП');
  const trStats = getRepairTypeStats('ТР');

  const activeRepairs = repairs.filter(r => r.current_status !== CASE_STATUS.READY);
  const totalDwellHours = activeRepairs.reduce((acc, r) => acc + getWagonDwellHours(r), 0);
  const totalDwellDays = (totalDwellHours / 24).toFixed(1);
  const avgHoursPerWagon = activeRepairs.length > 0 ? Math.round(totalDwellHours / activeRepairs.length) : 0;
  const avgDaysPerWagon = (avgHoursPerWagon / 24).toFixed(1);

  const availableTransitions = selectedCase ? (ALLOWED_TRANSITIONS[selectedCase.current_status as keyof typeof ALLOWED_TRANSITIONS] || []) : [];
  const isInitialPhase = selectedCase && [CASE_STATUS.PLANNED, CASE_STATUS.QUEUE].includes(selectedCase.current_status as any);
  const allSigned = selectedCase?.shop_signatures && DEFAULT_SHOPS.every(s => selectedCase.shop_signatures[s.key]?.signed);
  
  const actPhotoDoc = documents.find(d => d.doc_type?.includes('ВУ-22') && d.file_url);
  const hasActPhoto = Boolean(actPhotoDoc);

  // 🎯 ЛОГИКА СНЯТИЯ СИГНАЛА ЗАДЕРЖКИ
  const isPausedState = selectedCase?.current_status === CASE_STATUS.PAUSED;
  
  // 1. Ищем автора паузы в журнале событий
  const lastPauseEvent = statusHistory.find(ev => ev.new_status === CASE_STATUS.PAUSED || ev.new_status === '08 REPAIR_PAUSED');
  const isPauseAuthor = Boolean(
    lastPauseEvent && (
      lastPauseEvent.user_id === user?.id || 
      (lastPauseEvent.users?.role && lastPauseEvent.users.role === activeRole)
    )
  );

  // 2. Ищем ответственную роль по категории задержки
  const activeDelay = delayLogs.find(d => d.repair_id === selectedCase?.repair_id && !d.end_datetime);
  const isDelayResponsible = Boolean(
    activeDelay && (
      (activeDelay.category === 'Materials' && activeRole === 'procurement') ||
      (activeDelay.category === 'Equipment' && activeRole === 'mechanic') ||
      (activeDelay.responsible_party && activeDelay.responsible_party.includes(user?.name || ''))
    )
  );

  // Права на снятие задержки: Админ, ОТК, Диспетчер, Автор задержки или Ответственный за проблему
  const canResumeFromPause = activeRole === 'ADMIN' || activeRole === 'otk' || activeRole === 'operator' || isPauseAuthor || isDelayResponsible;

  const visibleTransitions = isGuest ? [] : (
    isPausedState 
      ? (canResumeFromPause ? availableTransitions : [])
      : (isAdminOrOperator ? availableTransitions : availableTransitions.filter((st: string) => st === CASE_STATUS.PAUSED))
  );

  const renderShopTimeInfo = (startAt: string | null, endAt: string | null, targetHours: number) => {
    const startTime = startAt ? new Date(startAt).getTime() : null;
    const endTime = endAt ? new Date(endAt).getTime() : new Date().getTime();
    if (!startTime) return { text: `Норма: ${targetHours} ч`, isOverdue: false };
    const hoursSpent = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
    return { text: hoursSpent < 1 ? `${Math.round(hoursSpent * 60)} мин / Норма: ${targetHours} ч` : `${hoursSpent.toFixed(1)} ч / Норма: ${targetHours} ч`, isOverdue: hoursSpent > targetHours };
  };

  const currentRoleInfo = ROLES_LIST.find(r => r.key === activeRole);

  if (isOutsideTelegram) {
    return <div style={{ display: 'flex', height: '100vh', justifyContent: 'center', alignItems: 'center', background: 'var(--bg-main)', textAlign: 'center', padding: '20px' }}><div><h2 style={{ color: 'var(--status-paused)', marginBottom: '10px' }}>⛔ Доступ запрещен</h2><p style={{ color: 'var(--text-secondary)' }}>Пожалуйста, откройте это приложение внутри Telegram.</p></div></div>;
  }

  return (
    <div>
      <header className="brand-header">
        <h1 className="brand-title">ДЕПО TMS</h1>
        <span className="status-pill">{user?.name} {isGuest ? '(Гость)' : ''}</span>
      </header>

      <div className="content-area">
        {/* УВЕДОМЛЕНИЕ ДЛЯ ГОСТЯ */}
        {isGuest && (
          <div className="premium-card" style={{ borderLeft: '4px solid var(--status-queue)', background: 'var(--status-queue-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>⏳</span>
              <div>
                <div style={{ fontWeight: '800', fontSize: '12px', color: 'var(--status-queue)' }}>Режим наблюдения (Гость)</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Вы зашли впервые. Обратитесь к Администратору депо для получения доступа.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* СИГНАЛ ОПЕРАТОРУ О НЕОФОРМЛЕННЫХ ВАГОНАХ С КПП */}
        {unassignedWagonsCount > 0 && isAdminOrOperator && (
          <div className="premium-card" style={{ borderLeft: '4px solid var(--status-queue)', background: 'var(--status-queue-bg)' }} onClick={() => goToWagons(CASE_STATUS.QUEUE)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: '800', fontSize: '13px', color: 'var(--status-queue)' }}>
                  ⚠️ Неоформленные вагоны с КПП: {unassignedWagonsCount} шт.
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Охрана зафиксировала приход. Нажмите, чтобы присвоить реальные номера вагонов.
                </div>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--brand)', fontWeight: 'bold' }}>Внести →</span>
            </div>
          </div>
        )}

        {currentTab === 'home' && (
          <>
            {/* 1. БАННЕР-АЛАРМ ДИСПЕТЧЕРА */}
            {(dqViolations.length > 0 || forecastBreaches.length > 0 || readyNotDispatched.length > 0) && (
              <div className="premium-card" style={{ borderLeft: '4px solid var(--status-paused)', background: 'var(--status-paused-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <svg className="nav-icon-svg" style={{ stroke: 'var(--status-paused)', width: '18px', height: '18px' }} viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <h4 style={{ margin: 0, color: 'var(--status-paused)', fontSize: '13px', fontWeight: '800' }}>Требуют внимания диспетчера</h4>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#7f1d1d' }}>
                  {forecastBreaches.length > 0 && <div>• <b>Риск срыва SLA:</b> {forecastBreaches.length} ваг.</div>}
                  {readyNotDispatched.length > 0 && <div>• <b>Ожидают отправки:</b> {readyNotDispatched.length} ваг.</div>}
                  {dqViolations.map((v, i) => <div key={i}>• <b>Вагон №{v.wagon_number}:</b> {v.message}</div>)}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '4px 0 2px 0' }}>
              <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)' }}>На территории депо</span>
              <span style={{ fontSize: '18px', fontWeight: '900', color: 'var(--brand)' }}>{onSiteRepairs.length} ваг.</span>
            </div>

            {/* 2. BENTO СЕТКА СТАТИСТИКИ */}
            <div className="stats-grid">
              <div className="stat-box queue" onClick={() => goToWagons(CASE_STATUS.QUEUE)}>
                <span className="stat-label">В очереди</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.QUEUE).length}</span>
              </div>
              <div className="stat-box repair" onClick={() => goToWagons(CASE_STATUS.IN_REPAIR)}>
                <span className="stat-label">В ремонте</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.IN_REPAIR).length}</span>
              </div>
              <div className="stat-box paused" onClick={() => goToWagons(CASE_STATUS.PAUSED)}>
                <span className="stat-label">За задержано</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.PAUSED).length}</span>
              </div>
              <div className="stat-box ready" onClick={() => goToWagons(CASE_STATUS.READY)}>
                <span className="stat-label">Готовы</span>
                <span className="stat-value">{readyNotDispatched.length}</span>
              </div>
            </div>

            {/* 3. БЫСТРЫЕ ДЕЙСТВИЯ */}
            <div className="premium-card">
              <div style={{ fontSize: '11px', fontWeight: '800', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                ⚡ Быстрые действия
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {!isGuest && (activeRole === 'ADMIN' || activeRole === 'security' || activeRole === 'operator') && (
                  <button className="btn-primary" onClick={() => setShowAddModal(true)}>🛡️ Приход с КПП</button>
                )}
                {!isGuest && canManageWarehouse && (
                  <button className="btn-secondary" onClick={() => openAddItemModal()}>+ Новый товар</button>
                )}
                <button className="btn-secondary" onClick={() => setCurrentTab('warehouse')}>📦 Склад ТМЦ</button>
                <button className="btn-secondary" onClick={() => setCurrentTab('analytics')}>📊 Аналитика</button>
              </div>
            </div>

            {/* 4. РАЗБОР ЗАДЕРЖАННЫХ ВАГОНОВ */}
            {(() => {
              const activeDelays = delayLogs.filter(d => !d.end_datetime);
              if (activeDelays.length === 0) return null;
              const matCount = activeDelays.filter(d => d.category === 'Materials').length;
              const eqCount = activeDelays.filter(d => d.category === 'Equipment').length;
              const custCount = activeDelays.filter(d => d.category === 'Customer').length;

              return (
                <div className="premium-card" style={{ borderLeft: '4px solid var(--status-paused)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '800', color: 'var(--status-paused)' }}>🛑 Разбор задержек ({activeDelays.length})</span>
                    <span style={{ fontSize: '11px', color: 'var(--brand)', cursor: 'pointer', fontWeight: '700' }} onClick={() => goToWagons(CASE_STATUS.PAUSED)}>Все →</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-main)', padding: '8px 10px', borderRadius: '8px' }}>
                      <span>📦 Запчасти / Материалы: <b>{matCount} ваг.</b></span>
                      <span style={{ color: 'var(--text-secondary)' }}>Отв: Рустамжон</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-main)', padding: '8px 10px', borderRadius: '8px' }}>
                      <span>🛠 Оборудование: <b>{eqCount} ваг.</b></span>
                      <span style={{ color: 'var(--text-secondary)' }}>Отв: Абдурахмонжон</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-main)', padding: '8px 10px', borderRadius: '8px' }}>
                      <span>👤 Ждём решения Заказчика: <b>{custCount} ваг.</b></span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 5. ГОРЯЩИЕ ВАГОНЫ С НАИБОЛЬШИМ ПРОСТОЕМ */}
            {(() => {
              const criticalWagons = repairs
                .filter(r => r.current_status !== CASE_STATUS.READY)
                .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                .slice(0, 3);

              if (criticalWagons.length === 0) return null;

              return (
                <div className="premium-card">
                  <div style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-primary)', marginBottom: '8px' }}>🔥 Наибольший простой</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {criticalWagons.map(item => {
                      const daysOnSite = Math.max(0, Math.floor((new Date().getTime() - new Date(item.created_at).getTime()) / (1000 * 60 * 60 * 24)));
                      const isPaused = item.current_status === CASE_STATUS.PAUSED;

                      return (
                        <div 
                          key={item.repair_id} 
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-main)', padding: '8px 10px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer' }}
                          onClick={() => openCaseDetails(item)}
                        >
                          <div>
                            <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
                              № {item.wagons?.wagon_number?.startsWith('БЕЗ_№_') ? '⚠️ Требует номера' : item.wagons?.wagon_number}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{item.repair_type} • {item.wagons?.owner || 'Собственный'}</div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontWeight: '800', color: isPaused ? 'var(--status-paused)' : daysOnSite > 3 ? 'var(--status-queue)' : 'var(--brand)' }}>
                              {daysOnSite} дн.
                            </span>
                            <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>{STATUS_RU[item.current_status] || item.current_status}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 6. СИГНАЛ ДЕФИЦИТА СКЛАДА */}
            {(() => {
              const deficitItems = warehouseItems.filter(i => Number(i.quantity) <= Number(i.min_limit)).slice(0, 3);
              if (deficitItems.length === 0) return null;

              return (
                <div className="premium-card" style={{ borderLeft: '4px solid var(--status-queue)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '800', color: 'var(--status-queue)' }}>⚠️ Низкий остаток ТМЦ</span>
                    <span style={{ fontSize: '11px', color: 'var(--brand)', cursor: 'pointer', fontWeight: '700' }} onClick={() => setCurrentTab('warehouse')}>Склад →</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                    {deficitItems.map(item => {
                      const isZero = Number(item.quantity) <= 0;
                      return (
                        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-main)', padding: '6px 8px', borderRadius: '6px' }}>
                          <span>{item.name} <span style={{ color: 'var(--text-secondary)', fontSize: '9px' }}>({item.category})</span></span>
                          <span style={{ fontWeight: 'bold', color: isZero ? 'var(--status-paused)' : 'var(--status-queue)' }}>
                            {item.quantity} {item.unit} {isZero ? '(ДЕФИЦИТ)' : `(Мин: ${item.min_limit})`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {currentTab === 'wagons' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '16px' }}>
                Вагоны ({filteredRepairs.length})
              </h3>
              <div style={{ display: 'flex', gap: '6px' }}>
                {isFilterActive && (
                  <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--status-paused)' }} onClick={resetAllFilters}>
                    Сбросить
                  </button>
                )}
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={exportToCSV}>💾 Excel</button>
              </div>
            </div>

            <div className="premium-card" style={{ padding: '10px', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="search-wrapper">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input 
                  className="input-field" 
                  type="text" 
                  placeholder="Поиск по номеру вагона..." 
                  value={searchQuery} 
                  onChange={e => setSearchQuery(e.target.value)} 
                />
              </div>

              <div className="filters-grid">
                <select 
                  className="select-field" 
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  value={statusFilter || ''} 
                  onChange={e => setStatusFilter(e.target.value || null)}
                >
                  <option value="">Все статусы</option>
                  <option value={CASE_STATUS.QUEUE}>В очереди</option>
                  <option value={CASE_STATUS.IN_REPAIR}>В ремонте</option>
                  <option value={CASE_STATUS.PAUSED}>Задержано</option>
                  <option value={CASE_STATUS.READY}>Готов к отправке</option>
                </select>

                <select 
                  className="select-field" 
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  value={repairTypeFilter || ''} 
                  onChange={e => setRepairTypeFilter(e.target.value || null)}
                >
                  <option value="">Все виды ремонта</option>
                  <option value="ДР">Деповской (ДР)</option>
                  <option value="КРП">Переоборудование (КРП)</option>
                  <option value="ТР">Текущий (ТР)</option>
                  <option value="КР">Капитальный (КР)</option>
                </select>
              </div>

              <select 
                className="select-field" 
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                value={delayCategoryFilter || ''} 
                onChange={e => setDelayCategoryFilter(e.target.value || null)}
              >
                <option value="">Все категории задержек</option>
                <option value="Materials">📦 Запчасти / Материалы</option>
                <option value="Equipment">🛠 Поломка оборудования</option>
                <option value="Customer">👤 Заказчик</option>
                <option value="Railway">🚂 Железная дорога</option>
              </select>
            </div>

            {filteredRepairs.length === 0 ? (
              <div className="premium-card" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                🔍 Вагоны по выбранным фильтрам не найдены
              </div>
            ) : (
              filteredRepairs.map((item) => {
                const isUnassigned = item.wagons?.wagon_number?.startsWith('БЕЗ_№_');
                const isBreached = item.forecast_release && item.sla_deadline && new Date(item.forecast_release) > new Date(item.sla_deadline);
                const activeDelay = delayLogs.find(d => d.repair_id === item.repair_id && !d.end_datetime);
                
                const createdDate = item.created_at ? new Date(item.created_at) : new Date();
                const formattedDate = createdDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const daysOnSite = Math.max(0, Math.floor((new Date().getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

                return (
                  <div 
                    key={item.repair_id} 
                    className="premium-card" 
                    onClick={() => openCaseDetails(item)} 
                    style={{ 
                      cursor: 'pointer', 
                      borderLeft: isUnassigned ? '4px solid var(--status-queue)' : isBreached ? '4px solid var(--status-paused)' : 'none',
                      background: isUnassigned ? 'var(--status-queue-bg)' : 'var(--card-bg)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '15px', fontWeight: '800', color: isUnassigned ? 'var(--status-queue)' : 'var(--text-primary)' }}>
                        {isUnassigned ? '⚠️ Не оформлен (Приход КПП)' : `№ ${item.wagons?.wagon_number}`}
                      </span>
                      <span className="status-pill">{STATUS_RU[item.current_status] || item.current_status}</span>
                    </div>
                    
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{item.repair_type} • {item.wagons?.owner || 'Собственный'}</span>
                      <span style={{ color: isBreached ? 'var(--status-paused)' : 'var(--text-secondary)', fontWeight: isBreached ? 'bold' : 'normal' }}>
                        {isBreached ? '⚠️ Риск срыва' : (item.track_number ? `${item.track_number}, ${item.position_number}` : 'Не назначен')}
                      </span>
                    </div>

                    <div style={{ fontSize: '11px', color: 'var(--brand)', marginTop: '4px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      📅 Заход: {formattedDate} ({daysOnSite} дн.)
                    </div>

                    {activeDelay && (
                      <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed var(--border-subtle)', fontSize: '10px', color: 'var(--status-paused)' }}>
                        <div><b>⛔ {CATEGORY_RU[activeDelay.category] || activeDelay.category}:</b> {activeDelay.cause}</div>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {!isGuest && (activeRole === 'ADMIN' || activeRole === 'security') && <button className="fab" onClick={() => setShowAddModal(true)}>+</button>}
          </>
        )}

        {/* ВКЛАДКА СКЛАД */}
        {currentTab === 'warehouse' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>Остатки склада ({filteredWarehouseItems.length})</h3>
              {canManageWarehouse && (
                <button className="btn-primary" style={{ padding: '4px 10px', fontSize: '11px', width: 'auto' }} onClick={() => openAddItemModal()}>
                  + Новый товар
                </button>
              )}
            </div>

            <div className="premium-card" style={{ padding: '10px', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="search-wrapper">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input 
                  className="input-field" 
                  type="text" 
                  placeholder="Поиск детали или материала..." 
                  value={warehouseSearch} 
                  onChange={e => setWarehouseSearch(e.target.value)} 
                />
              </div>

              <select 
                className="select-field" 
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                value={warehouseCatFilter || ''} 
                onChange={e => setWarehouseCatFilter(e.target.value || null)}
              >
                <option value="">Все цеха и категории</option>
                <option value="Холодильный цех">❄️ Холодильный цех</option>
                <option value="Колёсный цех">⚙️ Колёсный цех</option>
                <option value="Автотормозной цех (АКП)">🛑 Автотормозной цех (АКП)</option>
                <option value="Цех электрооборудования">⚡ Цех электрооборудования</option>
                <option value="Ремонтно-заготовительный цех">📐 Ремонтно-заготовительный цех</option>
                <option value="Цех механического оборудования">⛓️ Цех мехоборудования</option>
                <option value="Тележечный цех">🔧 Тележечный цех</option>
                <option value="Кузовной / Сварочный">🔨 Кузовной цех</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filteredWarehouseItems.map(item => {
                const isOutOfStock = Number(item.quantity) <= 0;
                const isLowStock = Number(item.quantity) <= Number(item.min_limit) && !isOutOfStock;
                
                return (
                  <div key={item.id} className="premium-card" style={{ borderLeft: isOutOfStock ? '4px solid var(--status-paused)' : isLowStock ? '4px solid var(--status-queue)' : '4px solid var(--status-ready)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 'bold' }}>{item.name}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>{item.category}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '16px', fontWeight: '800', color: isOutOfStock ? 'var(--status-paused)' : isLowStock ? 'var(--status-queue)' : 'var(--status-ready)' }}>
                          {item.quantity} {item.unit}
                        </div>
                        <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                          Мин. норма: {item.min_limit} {item.unit}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', paddingTop: '6px', borderTop: '1px dashed var(--border-subtle)' }}>
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: isOutOfStock ? 'var(--status-paused)' : isLowStock ? 'var(--status-queue)' : 'var(--status-ready)' }}>
                        {isOutOfStock ? '🔴 Нет на складе' : isLowStock ? '🟡 Низкий остаток' : '🟢 В наличии'}
                      </span>

                      {canManageWarehouse && (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button 
                            className="btn-primary" 
                            style={{ padding: '3px 8px', fontSize: '10px', width: 'auto', background: 'var(--status-ready)' }} 
                            onClick={() => openStockAdjustModal(item, 'ADD')}
                          >
                            + Приход
                          </button>
                          <button 
                            className="btn-secondary" 
                            style={{ padding: '3px 8px', fontSize: '10px', width: 'auto', color: 'var(--status-paused)' }} 
                            onClick={() => openStockAdjustModal(item, 'SUBTRACT')}
                          >
                            − Списать
                          </button>
                          <button 
                            className="btn-secondary" 
                            style={{ padding: '3px 6px', fontSize: '10px', width: 'auto' }} 
                            onClick={() => openAddItemModal(item)}
                          >
                            ✏️
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {currentTab === 'analytics' && (
          <>
            <div className="premium-card" style={{ borderLeft: '4px solid var(--brand)' }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--brand)' }}>📊 Сводный простой вагонов</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px' }}>
                <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>Активный налёт времени:</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '2px' }}>{Math.round(totalDwellHours).toLocaleString()} ч</div>
                  <div style={{ fontSize: '10px', color: 'var(--brand)' }}>({totalDwellDays} вагон-дней)</div>
                </div>
                <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>Средний простой:</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '2px' }}>{avgHoursPerWagon} ч</div>
                  <div style={{ fontSize: '10px', color: 'var(--brand)' }}>({avgDaysPerWagon} дн/вагон)</div>
                </div>
              </div>
            </div>

            <div className="premium-card">
              <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>⏱️ Время цикла по видам ремонта</h3>
              <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🛠️ Деповской ремонт (ДР) — {drStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '10px' }}>
                    <span>Медиана: <b>{drStats.medianHours} ч</b> ({drStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{drStats.p90Hours} ч</b> ({drStats.p90Days} дн)</span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🔄 Переоборудование (КРП) — {krpStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '10px' }}>
                    <span>Медиана: <b>{krpStats.medianHours} ч</b> ({krpStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{krpStats.p90Hours} ч</b> ({krpStats.p90Days} дн)</span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🔧 Текущий ремонт (ТР) — {trStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '10px' }}>
                    <span>Медиана: <b>{trStats.medianHours} ч</b> ({trStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{trStats.p90Hours} ч</b> ({trStats.p90Days} дн)</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="premium-card">
              <h3 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--status-paused)' }}>🚨 Структура задержек (Парето)</h3>
              {(Object.entries(lostWagonDays.byCategory) as [string, number][]).map(([cat, days]) => {
                const hours = Math.round(days * 24);
                const percent = Math.min(100, (days / (lostWagonDays.totalDays || 1)) * 100);
                const ruCat = CATEGORY_RU[cat] || cat;

                return (
                  <div key={cat} style={{ marginBottom: '10px', background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 'bold', marginBottom: '4px' }}>
                      <span>{ruCat}</span>
                      <span style={{ color: 'var(--status-paused)' }}>{hours.toLocaleString()} ч ({days.toFixed(1)} дн)</span>
                    </div>
                    <div style={{ background: 'rgba(220, 38, 38, 0.1)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ width: `${percent}%`, background: 'var(--status-paused)', height: '100%', borderRadius: '4px' }} />
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {percent.toFixed(1)}% от всех задержек
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {currentTab === 'profile' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="premium-card" style={{ textAlign: 'center' }}>
              <h3 style={{ margin: '0 0 4px 0' }}>{user?.name}</h3>
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Роль в БД: <b>{user?.role || 'GUEST'}</b> 
                {user?.role === 'ADMIN' && <br />}
                {user?.role === 'ADMIN' && <span style={{color: 'var(--brand)'}}>Режим симуляции: {currentRoleInfo?.label}</span>}
              </p>
            </div>

            {user?.role === 'ADMIN' ? (
              <>
                <div className="premium-card" style={{ borderLeft: '4px solid var(--brand)' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--brand)' }}>🔑 Быстрая симуляция роли (Тестирование)</h4>
                  <select 
                    className="select-field" 
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{ margin: 0, fontSize: '12px', fontWeight: 'bold' }} 
                    value={activeRole} 
                    onChange={e => handleRoleChange(e.target.value)}
                  >
                    <option value="GUEST">⏳ Гость (Без доступа)</option>
                    {ROLES_LIST.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </div>

                <div className="premium-card">
                  <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--brand)' }}>👥 Назначение ролей сотрудникам депо</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {allUsersList.map(u => (
                      <div key={u.id} className="user-row-card">
                        <div className="user-row-header">
                          <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{u.name || 'Сотрудник'}</span>
                          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>ID: {u.telegram_id}</span>
                        </div>
                        <select
                          className="select-field"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          style={{ margin: 0, fontSize: '11px', fontWeight: '600' }}
                          value={u.role || 'GUEST'}
                          onChange={async (e) => {
                            const newRole = e.target.value;
                            setLoading(true);
                            vibrate('medium');

                            const { error } = await supabase.rpc('update_user_role', {
                              p_target_user_id: u.id,
                              p_new_role: newRole
                            });

                            if (!error) {
                              alert(`Права для ${u.name} изменены на: ${newRole}`);
                              setAllUsersList(prev => prev.map(userItem => 
                                userItem.id === u.id ? { ...userItem, role: newRole } : userItem
                              ));
                              loadData();
                            } else {
                              alert('Ошибка изменения роли: ' + error.message);
                            }
                            setLoading(false);
                          }}
                        >
                          <option value="GUEST">⏳ Гость (Без доступа)</option>
                          {ROLES_LIST.map(r => (
                            <option key={r.key} value={r.key}>{r.label}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="premium-card">
                  <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--brand)' }}>⚙️ Персонал и Нормативы цехов</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {Object.entries(shopMasters).map(([key, val]) => (
                      <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--bg-main)', padding: '8px', borderRadius: '8px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--brand)' }}>{val.label}</span>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', flex: '1 1 110px' }} type="text" value={val.master} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, master: e.target.value } })} placeholder="ФИО" />
                          <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', flex: '1 1 90px' }} type="text" value={val.tg} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, tg: e.target.value } })} placeholder="@username" />
                          {key !== 'procurement' && key !== 'mechanic' && key !== 'deputy' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 90px' }}>
                              <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', width: '50px' }} type="number" step="0.5" value={val.targetHours} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, targetHours: Number(e.target.value) } })} placeholder="Норма" />
                              <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>ч.</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    <button className="btn-primary" style={{ marginTop: '4px' }} onClick={handleSaveMasters} disabled={loading}>💾 Сохранить персонал</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="premium-card" style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '11px' }}>
                🔒 Панель управления ролями и персоналом доступна только Начальнику депо.
              </div>
            )}
          </div>
        )}
      </div>

      {/* НИЖНЕЕ МЕНЮ С ВЕКТОРНЫМИ ИКОНКАМИ */}
      <nav className="bottom-nav">
        <button className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} onClick={() => setCurrentTab('home')}>
          <svg className="nav-icon-svg" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Главная</span>
        </button>
        <button className={`nav-item ${currentTab === 'wagons' ? 'active' : ''}`} onClick={() => setCurrentTab('wagons')}>
          <svg className="nav-icon-svg" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          <span>Вагоны</span>
        </button>
        <button className={`nav-item ${currentTab === 'warehouse' ? 'active' : ''}`} onClick={() => setCurrentTab('warehouse')}>
          <svg className="nav-icon-svg" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          <span>Склад</span>
        </button>
        <button className={`nav-item ${currentTab === 'analytics' ? 'active' : ''}`} onClick={() => setCurrentTab('analytics')}>
          <svg className="nav-icon-svg" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          <span>Аналитика</span>
        </button>
        <button className={`nav-item ${currentTab === 'profile' ? 'active' : ''}`} onClick={() => setCurrentTab('profile')}>
          <svg className="nav-icon-svg" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>Профиль</span>
        </button>
      </nav>

      {/* МОДАЛКА БЫСТРОГО ПРИХОДА / РАСХОДА */}
      {!isGuest && showStockAdjustModal && adjustingItem && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 6px 0', fontSize: '15px' }}>
              {adjustMode === 'ADD' ? '📥 Приход на склад' : '📤 Списание со склада'}
            </h3>
            <div style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--brand)', marginBottom: '10px' }}>
              {adjustingItem.name}
            </div>

            <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>
              {adjustMode === 'ADD' ? 'Сколько поступило:' : 'Сколько списать:'}
            </label>
            <input 
              className="input-field" 
              style={{ marginTop: '4px', fontSize: '16px', fontWeight: 'bold' }} 
              type="number" 
              placeholder="10" 
              value={stockDelta} 
              onChange={e => setStockDelta(e.target.value)} 
            />

            <div style={{ background: 'var(--bg-main)', padding: '10px', borderRadius: '8px', margin: '10px 0', fontSize: '12px' }}>
              <div>В наличии сейчас: <b>{adjustingItem.quantity} {adjustingItem.unit}</b></div>
              <div style={{ marginTop: '4px', color: adjustMode === 'ADD' ? 'var(--status-ready)' : 'var(--status-paused)', fontWeight: 'bold' }}>
                Станет на складе: {
                  adjustMode === 'ADD'
                    ? Number(adjustingItem.quantity) + (Number(stockDelta) || 0)
                    : Math.max(0, Number(adjustingItem.quantity) - (Number(stockDelta) || 0))
                } {adjustingItem.unit}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowStockAdjustModal(false)}>Отмена</button>
              <button 
                className="btn-primary" 
                style={{ background: adjustMode === 'ADD' ? 'var(--status-ready)' : 'var(--status-paused)' }} 
                onClick={handleConfirmStockAdjust} 
                disabled={loading}
              >
                {adjustMode === 'ADD' ? '✓ Подтвердить приход' : '✓ Подтвердить списание'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* МОДАЛКА СОЗДАНИЯ / ИНВЕНТАРИЗАЦИИ ПАРАМЕТРОВ ТОВАРА */}
      {!isGuest && showItemModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>📦 {editingItem ? 'Параметры и ревизия ТМЦ' : 'Новый товар на склад'}</h3>
            
            <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Наименование позиции:</label>
            <input className="input-field" style={{ marginTop: '2px' }} type="text" placeholder="Например: Пена монтажная" value={itemName} onChange={e => setItemName(e.target.value)} />
            
            <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Цех / Категория:</label>
            <select 
              className="select-field" 
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{ marginTop: '2px' }} 
              value={itemCategory} 
              onChange={e => setItemCategory(e.target.value)}
            >
              <option value="Холодильный цех">❄️ Холодильный цех</option>
              <option value="Колёсный цех">⚙️ Колёсный цех</option>
              <option value="Автотормозной цех (АКП)">🛑 Автотормозной цех (АКП)</option>
              <option value="Цех электрооборудования">⚡ Цех электрооборудования</option>
              <option value="Ремонтно-заготовительный цех">📐 Ремонтно-заготовительный цех</option>
              <option value="Цех механического оборудования">⛓️ Цех мехоборудования</option>
              <option value="Тележечный цех">🔧 Тележечный цех</option>
              <option value="Кузовной / Сварочный">🔨 Кузовной цех</option>
            </select>

            <div style={{ display: 'flex', gap: '6px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Текущий остаток:</label>
                <input className="input-field" style={{ marginTop: '2px' }} type="number" placeholder="10" value={itemQty} onChange={e => setItemQty(e.target.value)} />
              </div>
              <div style={{ flex: 0.8 }}>
                <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Ед. изм.:</label>
                <input className="input-field" style={{ marginTop: '2px' }} type="text" placeholder="шт / л / кг" value={itemUnit} onChange={e => setItemUnit(e.target.value)} />
              </div>
            </div>

            <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Минимальный порог дефицита:</label>
            <input className="input-field" style={{ marginTop: '2px' }} type="number" placeholder="5" value={itemMinLimit} onChange={e => setItemMinLimit(e.target.value)} />

            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowItemModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleSaveWarehouseItem} disabled={loading}>
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка: ПРОСТОЙ ВВОД КОЛИЧЕСТВА НА КПП */}
      {!isGuest && showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 6px 0', fontSize: '15px' }}>🛡️ КПП: Приемка состава</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 10px 0' }}>
              Укажите количество прибывших вагонов. Номера вагонов сможет позже занести Оператор/Диспетчер.
            </p>

            <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Количество вагонов:</label>
            <input 
              className="input-field" 
              style={{ marginTop: '4px', fontSize: '18px', fontWeight: 'bold', textAlign: 'center' }} 
              type="number" 
              min={1} 
              max={100} 
              value={arrivalCount} 
              onChange={e => setArrivalCount(Math.max(1, Number(e.target.value) || 1))} 
            />

            <div style={{ display: 'flex', gap: '6px', marginTop: '16px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleKppArrival} disabled={loading}>
                Зарегистрировать ({arrivalCount} ваг.)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Универсальная Модалка Вагона */}
      {selectedCase && !showDelayModal && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="bottom-sheet">
            <div className="sheet-handle"></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px' }}>
                  {selectedCase.wagons?.wagon_number?.startsWith('БЕЗ_№_') ? '⚠️ Вагон без номера' : `№ ${selectedCase.wagons?.wagon_number}`}
                </h3>
                <span className="status-pill">{STATUS_RU[selectedCase.current_status] || selectedCase.current_status}</span>
              </div>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'transparent', border: 'none', fontSize: '16px' }}>✕</button>
            </div>

            {/* БЛОК ВВОДА РЕАЛЬНОГО 8-ЗНАЧНОГО НОМЕРА ВАГОНА ДЛЯ ОПЕРАТОРА */}
            {isAdminOrOperator && (
              <div className="premium-card" style={{ borderLeft: '4px solid var(--brand)', background: 'var(--brand-light)' }}>
                <div style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--brand)', marginBottom: '6px' }}>
                  {selectedCase.wagons?.wagon_number?.startsWith('БЕЗ_№_') ? '✏️ Присвоить реальный 8-значный номер вагона:' : '✏️ Изменить номер вагона:'}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input 
                    className="input-field" 
                    style={{ margin: 0, fontSize: '14px', fontWeight: 'bold', background: '#ffffff' }} 
                    type="text" 
                    maxLength={8} 
                    placeholder="Например: 51234567" 
                    value={editingWagonNum} 
                    onChange={e => setEditingWagonNum(e.target.value.replace(/\D/g, ''))} 
                  />
                  <button className="btn-primary" style={{ width: 'auto', padding: '0 12px', fontSize: '11px' }} onClick={handleSaveWagonNumber} disabled={loading || editingWagonNum.length !== 8}>
                    💾 Сохранить
                  </button>
                </div>
              </div>
            )}

            <div className="premium-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--brand)', fontWeight: 'bold' }}>
                  📅 Дата захода в депо: {new Date(selectedCase.created_at).toLocaleString('ru-RU')}
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', width: '90px' }}>Вид ремонта:</span>
                  <select 
                    className="select-field" 
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{ margin: 0, padding: '4px 8px', fontSize: '11px', flex: 1 }} 
                    value={selectedCase.repair_type || 'ДР'} 
                    disabled={!isAdminOrOperator || loading}
                    onChange={async (e) => {
                      const newType = e.target.value;
                      setLoading(true);
                      const { error } = await supabase.rpc('update_repair_type', { p_repair_id: selectedCase.repair_id, p_repair_type: newType, p_user_id: user?.id || null });
                      if (!error) { setSelectedCase({ ...selectedCase, repair_type: newType }); loadData(); } 
                      else { alert('Ошибка смены вида ремонта: ' + error.message); }
                      setLoading(false);
                    }}>
                    <option value="КР">КР (Капитальный)</option><option value="ДР">ДР (Деповской)</option><option value="ТР">ТР (Текущий)</option><option value="КРП">КРП (С продлением)</option><option value="ДРП">ДРП (Деповской с продлением)</option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', width: '90px' }}>Собственник:</span>
                  <input 
                    className="input-field" 
                    style={{ margin: 0, padding: '4px 8px', fontSize: '11px', flex: 1 }} 
                    type="text" 
                    value={selectedCase.wagons?.owner || ''} 
                    disabled={!isAdminOrOperator || loading}
                    placeholder="Укажите собственника"
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedCase({ ...selectedCase, wagons: { ...selectedCase.wagons, owner: val } });
                    }}
                    onBlur={async (e) => {
                      if (!selectedCase.wagons?.id) return;
                      await supabase.rpc('update_wagon_owner', { 
                        p_wagon_id: selectedCase.wagons.id, 
                        p_owner: e.target.value, 
                        p_user_id: user?.id || null 
                      });
                      loadData();
                    }}
                  />
                </div>
              </div>
            </div>

            {/* БЛОК ЦЕХОВ */}
            {!isInitialPhase && (
              <div className="premium-card">
                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand)' }}>🏗️ Этапы ремонта и Ответственные цехов</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {DEFAULT_SHOPS.map(s => {
                    const prog = selectedCase.shop_progress?.[s.key] || { status: 'PENDING' };
                    const masterInfo = shopMasters[s.key] || { master: 'Мастер', tg: '@master', targetHours: 4 };
                    const isInProgress = prog.status === 'IN_PROGRESS';
                    const isDone = prog.status === 'DONE';
                    const canEdit = canPerformAction(s.key);
                    const timeInfo = renderShopTimeInfo(prog.start_at, prog.end_at, masterInfo.targetHours);

                    return (
                      <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: isInProgress ? 'var(--status-repair-bg)' : 'var(--bg-main)', borderLeft: isInProgress ? '3px solid var(--brand)' : 'none', padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>
                        <div>
                          <div style={{ fontWeight: 'bold' }}>{s.label}
                            <span style={{ color: timeInfo.isOverdue ? 'var(--status-paused)' : isInProgress ? 'var(--brand)' : 'var(--text-secondary)', fontSize: '10px', marginLeft: '4px', fontWeight: timeInfo.isOverdue ? 'bold' : 'normal' }}>
                              ({isInProgress ? 'В работе: ' : isDone ? 'Итого: ' : ''}{timeInfo.text}){timeInfo.isOverdue && ' ⚠️ Превышение!'}
                            </span>
                          </div>
                          <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>Ответственный: <b>{masterInfo.master}</b> (<a href={`https://t.me/${masterInfo.tg.replace('@', '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)', textDecoration: 'none' }}>{masterInfo.tg}</a>)</div>
                        </div>
                        <div>
                          {isDone ? (
                            <span style={{ color: 'var(--status-ready)', fontWeight: 'bold', fontSize: '10px' }}>✓ Готово</span>
                          ) : isInProgress ? (
                            canEdit ? <button className="btn-primary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto' }} onClick={() => handleUpdateShopStage(s.key, 'DONE')} disabled={loading}>Завершить</button> : <span style={{ color: 'var(--brand)', fontSize: '10px', fontWeight: 'bold' }}>▶ В работе</span>
                          ) : (
                            canEdit ? <button className="btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto' }} onClick={() => handleUpdateShopStage(s.key, 'IN_PROGRESS')} disabled={loading}>Начать</button> : <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>⏳ Ожидает</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {isInitialPhase ? (
              <>
                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand)' }}>📝 ШАГ 1. Комиссионный Акт (ВУ-22)</h4>
                  
                  <div style={{ background: 'var(--bg-main)', padding: '8px', borderRadius: '8px', marginBottom: '8px', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 'bold' }}>📸 Фото / Скан Акта ВУ-22:</div>
                      <div style={{ fontSize: '10px', color: hasActPhoto ? 'var(--status-ready)' : 'var(--status-paused)', marginTop: '2px' }}>
                        {hasActPhoto ? '✓ Файл прикреплен и верифицирован' : '❌ Файл не прикреплен (завоз заблокирован)'}
                      </div>
                    </div>

                    {isAdminOrDocs && (
                      <label className="btn-primary" style={{ padding: '4px 8px', fontSize: '10px', width: 'auto', cursor: 'pointer', display: 'inline-block', margin: 0 }}>
                        {hasActPhoto ? '📷 Заменить' : '📷 Загрузить фото'}
                        <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleUploadActPhoto} disabled={loading} />
                      </label>
                    )}
                  </div>

                  {hasActPhoto && actPhotoDoc?.file_url && (
                    <div style={{ marginBottom: '8px', textAlign: 'right' }}>
                      <a href={actPhotoDoc.file_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--brand)', textDecoration: 'none', fontWeight: 'bold' }}>
                        🔍 Открыть прикрепленное фото акта
                      </a>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {DEFAULT_SHOPS.map(s => {
                      const sig = selectedCase.shop_signatures?.[s.key];
                      const masterInfo = shopMasters[s.key] || { master: 'Мастер', tg: '@master' };
                      const canEdit = canPerformAction(s.key);
                      return (
                        <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-main)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>
                          <div>
                            <b>{s.label}</b>
                            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>Ответственный: <b>{sig?.master_name || masterInfo.master}</b> ({masterInfo.tg}){sig?.signed_at && ` • ${new Date(sig.signed_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}</div>
                          </div>
                          {sig?.signed ? <span style={{ color: 'var(--status-ready)', fontWeight: 'bold' }}>✓ Подписано</span> : (canEdit ? <button className="btn-primary" style={{ width: 'auto', padding: '4px 8px', fontSize: '10px' }} onClick={() => handleSignAct(s.key)} disabled={loading}>Подписать</button> : <span style={{ color: 'var(--status-queue)', fontSize: '10px' }}>⏳ Ожидает</span>)}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand)' }}>🏗️ ШАГ 2. Размещение вагона</h4>
                  {selectedCase.track_number ? <div style={{ fontSize: '11px', color: 'var(--status-ready)', marginBottom: '8px', background: 'var(--bg-main)', padding: '6px', borderRadius: '6px' }}>📍 Завезён на: <b>{selectedCase.track_number}, {selectedCase.position_number}</b></div> : <div style={{ fontSize: '11px', color: 'var(--status-queue)', marginBottom: '8px', background: 'var(--bg-main)', padding: '6px', borderRadius: '6px' }}>⏳ Находится в очереди с <b>{new Date(selectedCase.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b></div>}
                  
                  {(!allSigned || !hasActPhoto) && (
                    <div style={{ fontSize: '11px', color: 'var(--status-paused)', marginBottom: '8px', fontWeight: 'bold' }}>
                      ⚠️ Завоз доступен после подписи акта всеми мастерами И загрузки фото Акта ВУ-22.
                    </div>
                  )}
                  
                  {isAdminOrOperator && (
                    <>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                        <select 
                          className="select-field" 
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          style={{ margin: 0 }} 
                          value={track} 
                          onChange={e => setTrack(e.target.value)}
                        >
                          <option value="Путь 1">Путь №1</option>
                          <option value="Путь 2">Путь №2</option>
                        </select>

                        <select 
                          className="select-field" 
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          style={{ margin: 0 }} 
                          value={position} 
                          onChange={e => setPosition(e.target.value)}
                        >
                          <option value="Позиция 1">Позиция 1</option>
                          <option value="Позиция 2">Позиция 2</option>
                          <option value="Позиция 3">Позиция 3</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn-secondary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(false)} disabled={loading || !allSigned || !hasActPhoto}>⏳ В очередь</button>
                        <button className="btn-primary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(true)} disabled={loading || !allSigned || !hasActPhoto}>➡️ Завезти на путь</button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {selectedMetrics && (
                  <div className="premium-card">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand)' }}>⏱️ Анализ времени простоя</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px' }}>
                      <div>Всего в депо: <b>{selectedMetrics.total_dwell_hours} ч</b></div><div>В очереди: <b>{selectedMetrics.queue_hours} ч</b></div>
                      <div>Общий ремонт: <b>{selectedMetrics.gross_repair_hours} ч</b></div><div>Задержки: <b style={{ color: 'var(--status-paused)' }}>{selectedMetrics.paused_hours} ч</b></div>
                    </div>
                    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border-subtle)', fontSize: '11px', display: 'flex', justifyContent: 'space-between' }}><span>Чистый ремонт:</span><b style={{ color: 'var(--status-ready)' }}>{selectedMetrics.net_repair_hours} ч</b></div>
                  </div>
                )}
                
                {visibleTransitions.length > 0 && (
                  <div className="premium-card">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }}>Допустимые действия:</h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {visibleTransitions.map((st: string) => <button key={st} disabled={loading} onClick={() => handleUpdateStatus(st)} className="btn-primary" style={{ padding: '6px 10px', fontSize: '11px', width: 'auto', background: st === CASE_STATUS.PAUSED ? 'var(--status-paused)' : 'var(--brand)' }}>{st === CASE_STATUS.PAUSED ? '⛔ Сообщить о задержке' : `→ ${STATUS_RU[st] || st}`}</button>)}
                    </div>
                  </div>
                )}

                <div className="premium-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}><h4 style={{ margin: 0, fontSize: '13px', color: 'var(--brand)' }}>📄 Документы и Акты</h4></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                    {documents.map((d: any) => (
                      <div key={d.id || d.created_at} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-main)', padding: '6px 10px', borderRadius: '8px', fontSize: '11px' }}>
                        <span>
                          <b>{d.doc_type}</b> №{d.doc_number}
                          {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" style={{ marginLeft: '6px', color: 'var(--brand)', textDecoration: 'none' }}>[🖼️ Скан]</a>}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{d.doc_date || ''}</span>
                      </div>
                    ))}
                  </div>
                  {isAdminOrDocs && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <select 
                        className="select-field" 
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        style={{ margin: 0, flex: 1.2 }} 
                        value={docType} 
                        onChange={e => setDocType(e.target.value)}
                      >
                        {DOCUMENT_TYPES.map(dt => <option key={dt} value={dt}>{dt}</option>)}
                      </select>
                      <input className="input-field" style={{ margin: 0, flex: 0.8 }} type="text" placeholder="№ док." value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                      <button className="btn-primary" style={{ width: 'auto', padding: '0 12px' }} onClick={handleAddDocument} disabled={loading}>+</button>
                    </div>
                  )}
                </div>
                
                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>📜 Журнал событий</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {statusHistory.map((ev: any) => (
                      <div key={ev.event_id || ev.event_datetime} style={{ fontSize: '10px', padding: '6px', background: 'var(--bg-main)', borderRadius: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}><span>{STATUS_RU[ev.new_status] || ev.new_status}</span><span style={{ color: 'var(--brand)', fontWeight: 'normal' }}>👤 {ev.users?.name || 'Система'}</span></div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '9px', marginTop: '2px' }}>{new Date(ev.event_datetime).toLocaleString()}</div>
                        {ev.comment && <div style={{ fontStyle: 'italic', marginTop: '2px', color: 'var(--text-primary)' }}>{ev.comment}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {activeRole === 'ADMIN' && (
              <button 
                className="btn-primary" 
                style={{ background: 'var(--status-paused)', marginTop: '12px', width: '100%' }} 
                onClick={handleDeleteCase} 
                disabled={loading}
              >
                🗑️ Удалить вагон из базы
              </button>
            )}
          </div>
        </div>
      )}

      {/* Модалка задержки */}
      {!isGuest && showDelayModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', color: 'var(--status-paused)', fontSize: '15px' }}>⛔ Регистрация задержки</h3>
            
            <select 
              className="select-field" 
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              value={delayType} 
              onChange={e => setDelayType(e.target.value as any)}
            >
              <option value="PRIMARY">Основная задержка</option>
              <option value="SECONDARY">Сопутствующая задержка</option>
            </select>
            
            <select 
              className="select-field" 
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              value={delayCategory} 
              onChange={e => {
                const cat = e.target.value; setDelayCategory(cat);
                if (cat === 'Materials') { const info = shopMasters.procurement; setResponsibleParty(info ? `${info.master} (${info.tg})` : 'Отдел снабжения / Закупки'); } 
                else if (cat === 'Equipment') { const info = shopMasters.mechanic; setResponsibleParty(info ? `${info.master} (${info.tg})` : 'Начальник цеха'); } 
                else { setResponsibleParty(''); }
              }}
            >
              <option value="Materials">Материалы / Запчасти</option>
              <option value="Equipment">Поломка оборудования</option>
              <option value="Customer">Заказчик</option>
              <option value="Railway">ЖД</option>
            </select>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={2} placeholder="Причина задержки" />
            <input className="input-field" type="text" value={responsibleParty} onChange={e => setResponsibleParty(e.target.value)} placeholder="Ответственный (ФИО)" />
            <input className="input-field" type="text" value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder="Следующее действие" />
            <input className="input-field" type="date" value={actionDeadline} onChange={e => setActionDeadline(e.target.value)} placeholder="Срок устранения (дедлайн)" />

            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}><button className="btn-secondary" onClick={() => setShowDelayModal(false)}>Отмена</button><button className="btn-primary" style={{ background: 'var(--status-paused)' }} onClick={handleConfirmDelay} disabled={loading}>Заблокировать</button></div>
          </div>
        </div>
      )}
    </div>
  );
}