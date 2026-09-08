import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import { 
  STATUS_RU, ALLOWED_TRANSITIONS, ON_SITE_STATUSES,
  runDataQualityChecks, calculateLostWagonDays,
  type DQViolation, type RepairTimeMetrics 
} from './depoEngine';
import { 
  notifyWagonArrived, notifyWagonsArrivedBulk, notifyActSigned, notifyPositionAssigned, 
  notifyShopStageUpdated, notifyDelayRegistered, notifyStatusChanged 
} from './telegramNotifier';
import './App.css';

declare global { interface Window { Telegram: any; } }

type AppTab = 'home' | 'wagons' | 'analytics' | 'profile';

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

const DOCUMENT_TYPES = ['Справка ВУ 36М', 'АКТ ВУ-23 (Ремонт завершен)', 'АКТ ВУ-22 (Дефектная ведомость)', 'Справка 2612', 'Справка 2602', 'Акт дефектации'];
const DEFAULT_SHOPS = [
  { key: 'bogie', label: 'Тележечный цех' },
  { key: 'wheels', label: 'Колёсный цех' },
  { key: 'brakes', label: 'Автотормозной цех' },
  { key: 'body', label: 'Кузовной / Сварочный' },
  { key: 'cooling', label: 'Холодильный цех' }
];
const TRACKS_CONFIG = [
  { track: 'Путь 1', positions: ['Позиция 1', 'Позиция 2', 'Позиция 3'] },
  { track: 'Путь 2', positions: ['Позиция 1', 'Позиция 2', 'Позиция 3'] }
];
const ROLES_LIST = [
  { key: 'ADMIN', label: '👑 Начальник депо (Полный доступ)' },
  { key: 'operator', label: '👨‍💻 Оператор / Диспетчер (Размещение вагонов)' },
  { key: 'security', label: '🛡️ Охрана КПП (Приемка вагонов)' },
  { key: 'procurement', label: '📦 Отдел снабжения / Закупки (Материалы)' },
  { key: 'mechanic', label: '🛠 Начальник цеха (отвечает за ремонт и за остальные цеха)' },
  { key: 'bogie', label: '🔧 Мастер Тележечного цеха' },
  { key: 'wheels', label: '⚙️ Мастер Колёсного цеха' },
  { key: 'brakes', label: '🛑 Мастер Автотормозного цеха' },
  { key: 'body', label: '🔨 Мастер Кузовного цеха' },
  { key: 'cooling', label: '❄️ Мастер Холодильного цеха' },
  { key: 'docs', label: '📄 Оформитель актов (Делопроизводитель)' }
];

export default function App() {
  const [user, setUser] = useState<{ id: string; name: string; role: string; telegram_id?: string } | null>(null);
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [activeRole, setActiveRole] = useState<string>('GUEST');
  const [showAddModal, setShowAddModal] = useState(false);

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [repairTypeFilter, setRepairTypeFilter] = useState<string | null>(null);
  const [delayCategoryFilter, setDelayCategoryFilter] = useState<string | null>(null);

  const [repairs, setRepairs] = useState<RepairCase[]>([]);
  const [delayLogs, setDelayLogs] = useState<DelayLog[]>([]);
  const [dqViolations, setDqViolations] = useState<DQViolation[]>([]);
  
  const [shopMasters, setShopMasters] = useState<Record<string, ShopMasterConfig>>({
    procurement: { label: 'Отдел снабжения / Закупки', master: 'Петров В.В.', tg: '@depo_supply', role: 'SUPPLY', targetHours: 0 },
    mechanic: { label: 'Начальник цеха (отвечает за ремонт и за остальные цеха)', master: 'Абдурахмонжон', tg: '@Abdyraxmonjon', role: 'MECHANIC', targetHours: 0 },
    bogie: { label: 'Тележечный цех', master: 'Иванов И.И.', tg: '@master_bogie', role: 'MASTER', targetHours: 4 },
    wheels: { label: 'Колёсный цех', master: 'Петров П.П.', tg: '@master_wheels', role: 'MASTER', targetHours: 3 },
    brakes: { label: 'Автотормозной цех', master: 'Сидоров С.С.', tg: '@master_brakes', role: 'MASTER', targetHours: 2 },
    body: { label: 'Кузовной / Сварочный', master: 'Кузнецов К.К.', tg: '@master_body', role: 'MASTER', targetHours: 5 },
    cooling: { label: 'Холодильный цех', master: 'Морозов М.М.', tg: '@master_cooling', role: 'MASTER', targetHours: 4 },
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

  const [wagonNumbersInput, setWagonNumbersInput] = useState('');
  const [ownerType, setOwnerType] = useState('Own');
  const [track, setTrack] = useState('Путь 1');
  const [position, setPosition] = useState('Позиция 1');

  const vibrate = (style: 'light' | 'medium' | 'heavy' = 'light') => {
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style); } catch (e) {}
  };

  useEffect(() => { initAuthAndData(); }, []);

  async function initAuthAndData() {
    let tgUser: any = null;
    try {
      const tg = window.Telegram?.WebApp || WebApp;
      if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor?.('bg_color'); tgUser = tg.initDataUnsafe?.user; }
    } catch (e) {}

    if (!tgUser?.id) { setIsOutsideTelegram(true); return; }

    const { data: dbUser } = await supabase.from('users').select('*').eq('telegram_id', tgUser.id).maybeSingle();
    if (dbUser) {
      setUser(dbUser); setActiveRole(dbUser.role || 'GUEST');
    } else {
      const { data: newUser } = await supabase.from('users').insert([{ telegram_id: tgUser.id, name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(), role: 'GUEST' }]).select().single();
      setUser(newUser); setActiveRole('GUEST');
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
    
    if (mastersData && mastersData.length > 0) {
      const mapped: Record<string, ShopMasterConfig> = {};
      mastersData.forEach((m: any) => { mapped[m.shop_key] = { label: m.shop_name, master: m.master_name, tg: m.telegram_handle || '@master', role: m.role_code || 'MASTER', targetHours: Number(m.target_hours || 4) }; });
      setShopMasters(prev => ({ ...prev, ...mapped }));
    }

    if (repairData) {
      setRepairs(repairData as unknown as RepairCase[]);
      setDelayLogs(delays as DelayLog[] || []);
      setDqViolations(runDataQualityChecks(repairData, delays || []));
    }
  }

  async function handleRoleChange(newRole: string) { setActiveRole(newRole); vibrate('medium'); }
  const canPerformAction = (targetShopKey: string) => activeRole === 'ADMIN' || activeRole === targetShopKey;
  const getMasterLabel = (shopKey: string) => { const info = shopMasters[shopKey]; return info ? `${info.master} (${info.tg})`.trim() : 'Мастер'; };
  const escapeCsvCell = (str: any) => str == null ? '""' : `"${String(str).replace(/"/g, '""')}"`;

  async function handleSaveMasters() {
    setLoading(true); vibrate('heavy');
    for (const [key, val] of Object.entries(shopMasters)) {
      const { error } = await supabase.rpc('update_shop_master', {
        p_shop_key: key, p_shop_name: val.label, p_master_name: val.master, p_tg: val.tg, p_role_code: val.role, p_target_hours: val.targetHours, p_user_id: user?.id
      });
      if (error) { alert(`Ошибка сохранения ${val.label}: ` + error.message); }
    }
    alert('Персонал сохранен!'); setLoading(false); loadData();
  }

  async function openCaseDetails(item: RepairCase) {
    vibrate('light'); setSelectedCase(item);
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

  async function handleCreateRepair() {
    const numbers = wagonNumbersInput.split(/[\s,]+/).filter(n => n.trim().length === 8);
    if (numbers.length === 0) { alert('Введите корректные 8-значные номера вагонов!'); return; }
    setLoading(true); vibrate('medium');
    let successCount = 0; const addedWagons: string[] = []; let lastDbError = '';

    const defaultWagonType = 'Полувагон';
    const defaultRepairType = 'ДР';
    const defaultOwner = ownerType === 'Own' ? 'Собственный' : 'Чужой';

    for (const num of numbers) {
      const { error } = await supabase.rpc('create_repair_case', { p_wagon_number: num, p_repair_type: defaultRepairType, p_user_id: user?.id, p_wagon_type: defaultWagonType, p_owner: defaultOwner, p_owner_type: ownerType });
      if (!error) { successCount++; addedWagons.push(num); } else { lastDbError = error.message; }
    }
    
    if (successCount > 0) { 
      if (addedWagons.length === 1) notifyWagonArrived(addedWagons[0], defaultRepairType, defaultOwner, defaultWagonType); 
      else notifyWagonsArrivedBulk(addedWagons, defaultRepairType, defaultOwner, defaultWagonType);
      alert(`Успешно принято вагонов: ${successCount} шт.`); setWagonNumbersInput(''); setShowAddModal(false); loadData(); 
    } else { alert(`Ошибка БД:\n${lastDbError}`); }
    setLoading(false);
  }

  async function handleSignAct(shopKey: string) {
    if (!canPerformAction(shopKey) || !selectedCase) return;
    setLoading(true);
    const signLabel = getMasterLabel(shopKey);
    const { data: updatedSigs, error } = await supabase.rpc('sign_defect_act', { p_repair_id: selectedCase.repair_id, p_shop_key: shopKey, p_user_name: signLabel, p_user_id: user?.id });
    if (!error) { notifyActSigned(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', signLabel); setSelectedCase({ ...selectedCase, shop_signatures: updatedSigs }); loadData(); }
    setLoading(false);
  }

  async function handleUpdateShopStage(shopKey: string, status: string) {
    if (!canPerformAction(shopKey) || !selectedCase) return;
    setLoading(true);
    const masterLabel = getMasterLabel(shopKey);
    const { data: updatedProgress, error } = await supabase.rpc('update_shop_stage', { p_repair_id: selectedCase.repair_id, p_shop_key: shopKey, p_status: status, p_master_name: masterLabel, p_user_id: user?.id });
    if (!error) { notifyShopStageUpdated(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', status, masterLabel); setSelectedCase({ ...selectedCase, shop_progress: updatedProgress, current_shop: shopKey }); loadData(); }
    setLoading(false);
  }

  async function handleAssignPosition(toRepair: boolean) {
    if (activeRole !== 'ADMIN' && activeRole !== 'operator') return; 
    if (!selectedCase) return;
    setLoading(true);
    const { error } = await supabase.rpc('assign_repair_position', { p_repair_id: selectedCase.repair_id, p_track: toRepair ? track : null, p_position: toRepair ? position : null, p_user_id: user?.id });
    if (!error) { notifyPositionAssigned(selectedCase.wagons?.wagon_number, toRepair, track, position); setSelectedCase(null); loadData(); }
    setLoading(false);
  }

  async function handleAddDocument() {
    if (activeRole !== 'ADMIN' && activeRole !== 'docs') return;
    if (!docNumber.trim() || !selectedCase) return;
    setLoading(true); vibrate('light');
    const { error } = await supabase.rpc('add_document', { p_repair_id: selectedCase.repair_id, p_doc_type: docType, p_doc_number: docNumber, p_user_id: user?.id });
    if (!error) { setDocNumber(''); const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', selectedCase.repair_id).order('created_at', { ascending: false }); setDocuments(docs || []); } 
    else { alert('Ошибка: ' + error.message); }
    setLoading(false);
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!selectedCase) return;
    if (newStatus === CASE_STATUS.PAUSED) { 
      setDelayCategory('Materials');
      const supplyInfo = shopMasters.procurement;
      setResponsibleParty(supplyInfo ? `${supplyInfo.master} (${supplyInfo.tg})` : 'Отдел снабжения');
      setDelayCause(''); setNextAction(''); setActionDeadline(''); setShowDelayModal(true); return; 
    }
    setLoading(true); vibrate('medium');
    const { error } = await supabase.rpc('change_repair_status', { p_repair_id: selectedCase.repair_id, p_new_status: newStatus, p_user_id: user?.id, p_comment: `Переход на ${STATUS_RU[newStatus] || newStatus}` });
    if (!error) { notifyStatusChanged(selectedCase.wagons?.wagon_number, STATUS_RU[newStatus] || newStatus); setSelectedCase(null); loadData(); } 
    else { alert('Ошибка: ' + error.message); }
    setLoading(false);
  }

  async function handleConfirmDelay() {
    if (!delayCause.trim() || !nextAction.trim() || !responsibleParty.trim()) { alert('Заполните все поля!'); return; }
    setLoading(true); vibrate('heavy');
    const { error } = await supabase.rpc('register_delay', { p_repair_id: selectedCase?.repair_id, p_category: delayCategory, p_delay_type: delayType, p_cause: delayCause, p_responsible_party: responsibleParty, p_next_action: nextAction, p_action_deadline: actionDeadline ? new Date(actionDeadline).toISOString() : null, p_user_id: user?.id });
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

  const resetAllFilters = () => {
    setStatusFilter(null);
    setSearchQuery('');
    setRepairTypeFilter(null);
    setDelayCategoryFilter(null);
  };

  const isFilterActive = statusFilter || searchQuery || repairTypeFilter || delayCategoryFilter;

  const lostWagonDays = calculateLostWagonDays(delayLogs);
  const readyNotDispatched = repairs.filter(r => r.current_status === CASE_STATUS.READY);
  const forecastBreaches = repairs.filter(r => r.forecast_release && r.sla_deadline && new Date(r.forecast_release) > new Date(r.sla_deadline));
  
  const getWagonDwellHours = (r: RepairCase) => {
    const start = new Date(r.created_at).getTime();
    const end = r.current_status === CASE_STATUS.READY && r.forecast_release 
      ? new Date(r.forecast_release).getTime() 
      : new Date().getTime();
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

    return {
      count: matchingRepairs.length,
      medianHours: Math.round(medianH),
      medianDays: Number((medianH / 24).toFixed(1)),
      p90Hours: Math.round(p90H),
      p90Days: Number((p90H / 24).toFixed(1))
    };
  };

  const drStats = getRepairTypeStats('ДР');
  const krpStats = getRepairTypeStats('КРП');
  const trStats = getRepairTypeStats('ТР');

  const activeRepairs = repairs.filter(r => r.current_status !== CASE_STATUS.READY);
  const totalDwellHours = activeRepairs.reduce((acc, r) => acc + getWagonDwellHours(r), 0);
  const totalDwellDays = (totalDwellHours / 24).toFixed(1);
  const avgHoursPerWagon = activeRepairs.length > 0 ? Math.round(totalDwellHours / activeRepairs.length) : 0;
  const avgDaysPerWagon = (avgHoursPerWagon / 24).toFixed(1);

  const availableTransitions = selectedCase ? (ALLOWED_TRANSITIONS[selectedCase.current_status] || []) : [];
  const isInitialPhase = selectedCase && [CASE_STATUS.PLANNED, CASE_STATUS.QUEUE].includes(selectedCase.current_status as any);
  const allSigned = selectedCase?.shop_signatures && DEFAULT_SHOPS.every(s => selectedCase.shop_signatures[s.key]?.signed);
  const parsedWagonsCount = wagonNumbersInput.split(/[\s,]+/).filter(n => n.trim().length === 8).length;

  const isAdminOrOperator = activeRole === 'ADMIN' || activeRole === 'operator';
  const isAdminOrDocs = activeRole === 'ADMIN' || activeRole === 'docs';
  const visibleTransitions = isAdminOrOperator ? availableTransitions : availableTransitions.filter((st: string) => st === CASE_STATUS.PAUSED);

  const renderShopTimeInfo = (startAt: string | null, endAt: string | null, targetHours: number) => {
    const startTime = startAt ? new Date(startAt).getTime() : null;
    const endTime = endAt ? new Date(endAt).getTime() : new Date().getTime();
    if (!startTime) return { text: `Норма: ${targetHours} ч`, isOverdue: false };
    const hoursSpent = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
    return { text: hoursSpent < 1 ? `${Math.round(hoursSpent * 60)} мин / Норма: ${targetHours} ч` : `${hoursSpent.toFixed(1)} ч / Норма: ${targetHours} ч`, isOverdue: hoursSpent > targetHours };
  };

  const currentRoleInfo = ROLES_LIST.find(r => r.key === activeRole);

  if (isOutsideTelegram) {
    return <div style={{ display: 'flex', height: '100vh', justifyContent: 'center', alignItems: 'center', background: 'var(--bg-color)', textAlign: 'center', padding: '20px' }}><div><h2 style={{ color: 'var(--danger)', marginBottom: '10px' }}>⛔ Доступ запрещен</h2><p style={{ color: 'var(--text-muted)' }}>Пожалуйста, откройте это приложение внутри Telegram.</p></div></div>;
  }

  return (
    <div>
      <header className="brand-header"><h1 className="brand-title">ДЕПО TMS</h1><span className="status-pill">{user?.name}</span></header>

      <div className="content-area">
        {currentTab === 'home' && (
          <>
            {(dqViolations.length > 0 || forecastBreaches.length > 0 || readyNotDispatched.length > 0) && (
              <div className="premium-card" style={{ borderLeft: '4px solid var(--danger)', background: 'rgba(255, 59, 48, 0.05)' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger)', fontSize: '13px' }}>🚨 Требуют внимания диспетчера</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                  {forecastBreaches.length > 0 && <div><b>⚠️ Риск срыва нормативного срока:</b> {forecastBreaches.length} ваг.</div>}
                  {readyNotDispatched.length > 0 && <div><b>🚂 Ожидают отправки:</b> {readyNotDispatched.length} ваг.</div>}
                  {dqViolations.map((v, i) => <div key={i}><b>Вагон №{v.wagon_number}:</b> {v.message}</div>)}
                </div>
              </div>
            )}
            <h3 style={{ margin: '12px 0 6px 0', fontSize: '16px' }}>На территории депо: {onSiteRepairs.length}</h3>
            <div className="stats-grid">
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.QUEUE); setCurrentTab('wagons'); }}><span className="stat-label" style={{ color: 'var(--warning)' }}>В очереди</span><span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.QUEUE).length}</span></div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.IN_REPAIR); setCurrentTab('wagons'); }}><span className="stat-label" style={{ color: 'var(--brand-color)' }}>В ремонте</span><span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.IN_REPAIR).length}</span></div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.PAUSED); setCurrentTab('wagons'); }}><span className="stat-label" style={{ color: 'var(--danger)' }}>Задержано</span><span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.PAUSED).length}</span></div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.READY); setCurrentTab('wagons'); }}><span className="stat-label" style={{ color: 'var(--success)' }}>Готовы</span><span className="stat-value">{readyNotDispatched.length}</span></div>
            </div>
            <div className="premium-card">
              <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--brand-color)' }}>🗺️ Схема ремонтных путей депо</h4>
              <div className="tracks-grid">
                {TRACKS_CONFIG.map(tr => (
                  <div key={tr.track} className="track-row">
                    <div className="track-title"><span>{tr.track}</span><span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>3 позиции</span></div>
                    <div className="positions-container">
                      {tr.positions.map(pos => {
                        const wagonOnPos = repairs.find(r => r.track_number === tr.track && r.position_number === pos);
                        const isPaused = wagonOnPos?.current_status === CASE_STATUS.PAUSED;
                        return (
                          <div key={pos} className={`position-slot ${wagonOnPos ? 'occupied' : ''} ${isPaused ? 'overdue' : ''}`} onClick={() => wagonOnPos && openCaseDetails(wagonOnPos)}>
                            <span className="slot-label">{pos}</span>
                            {wagonOnPos ? <span className="slot-wagon" style={{ color: isPaused ? 'var(--danger)' : 'var(--brand-color)' }}>№{wagonOnPos.wagons?.wagon_number}</span> : <span className="slot-empty">Свободно</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
                  <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--danger)' }} onClick={resetAllFilters}>
                    Сбросить фильтры
                  </button>
                )}
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={exportToCSV}>💾 Excel</button>
              </div>
            </div>

            <div className="premium-card" style={{ padding: '8px 10px', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <input 
                className="input-field" 
                style={{ margin: 0, padding: '6px 10px', fontSize: '12px' }} 
                type="text" 
                placeholder="🔍 Поиск по номеру вагона..." 
                value={searchQuery} 
                onChange={e => setSearchQuery(e.target.value)} 
              />

              <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
                <select 
                  className="select-field" 
                  style={{ margin: 0, padding: '4px 6px', fontSize: '11px', flex: 1 }} 
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
                  style={{ margin: 0, padding: '4px 6px', fontSize: '11px', flex: 1 }} 
                  value={repairTypeFilter || ''} 
                  onChange={e => setRepairTypeFilter(e.target.value || null)}
                >
                  <option value="">Все виды ремонта</option>
                  <option value="ДР">Деповской (ДР)</option>
                  <option value="КРП">Переоборудование (КРП)</option>
                  <option value="ТР">Текущий (ТР)</option>
                  <option value="КР">Капитальный (КР)</option>
                </select>

                <select 
                  className="select-field" 
                  style={{ margin: 0, padding: '4px 6px', fontSize: '11px', flex: 1.2 }} 
                  value={delayCategoryFilter || ''} 
                  onChange={e => setDelayCategoryFilter(e.target.value || null)}
                >
                  <option value="">Все задержки</option>
                  <option value="Materials">📦 Запчасти / Материалы</option>
                  <option value="Equipment">🛠 Оборудование</option>
                  <option value="Customer">👤 Заказчик</option>
                  <option value="Railway">🚂 ЖД</option>
                </select>
              </div>
            </div>

            {filteredRepairs.length === 0 ? (
              <div className="premium-card" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
                🔍 Вагоны по выбранным фильтрам не найдены
              </div>
            ) : (
              filteredRepairs.map((item) => {
                const isBreached = item.forecast_release && item.sla_deadline && new Date(item.forecast_release) > new Date(item.sla_deadline);
                const activeDelay = delayLogs.find(d => d.repair_id === item.repair_id && !d.end_datetime);
                
                // 🎯 ГАРАНТИРОВАННЫЙ РАСЧЕТ ДАТЫ И ДНЕЙ
                const createdDate = item.created_at ? new Date(item.created_at) : new Date();
                const formattedDate = createdDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const daysOnSite = Math.max(0, Math.floor((new Date().getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

                return (
                  <div key={item.repair_id} className="premium-card" onClick={() => openCaseDetails(item)} style={{ borderLeft: isBreached ? '4px solid var(--danger)' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '15px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
                      <span className="status-pill">{STATUS_RU[item.current_status] || item.current_status}</span>
                    </div>
                    
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{item.repair_type} • {item.wagons?.owner || 'Собственный'}</span>
                      <span style={{ color: isBreached ? 'var(--danger)' : 'var(--text-muted)', fontWeight: isBreached ? 'bold' : 'normal' }}>
                        {isBreached ? '⚠️ Риск срыва' : (item.track_number ? `${item.track_number}, ${item.position_number}` : 'Не назначен')}
                      </span>
                    </div>

                    {/* 🎯 ЗАМЕТНАЯ СТРОКА ДАТЫ ЗАХОДА В ДЕПО */}
                    <div style={{ fontSize: '11px', color: 'var(--brand-color)', marginTop: '4px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      📅 Заход: {formattedDate} ({daysOnSite} дн.)
                    </div>

                    {activeDelay && (
                      <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed var(--border-light)', fontSize: '10px', color: 'var(--danger)' }}>
                        <div><b>⛔ {CATEGORY_RU[activeDelay.category] || activeDelay.category}:</b> {activeDelay.cause}</div>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {(activeRole === 'ADMIN' || activeRole === 'security') && <button className="fab" onClick={() => setShowAddModal(true)}>+</button>}
          </>
        )}

        {currentTab === 'analytics' && (
          <>
            <div className="premium-card" style={{ borderLeft: '4px solid var(--brand-color)' }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--brand-color)' }}>📊 Сводный простой не завершенных вагонов</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px' }}>
                <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Активный налёт времени:</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '2px' }}>{Math.round(totalDwellHours).toLocaleString()} ч</div>
                  <div style={{ fontSize: '10px', color: 'var(--brand-color)' }}>({totalDwellDays} вагон-дней)</div>
                </div>
                <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Средний простой (активных):</div>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '2px' }}>{avgHoursPerWagon} ч</div>
                  <div style={{ fontSize: '10px', color: 'var(--brand-color)' }}>({avgDaysPerWagon} дн/вагон)</div>
                </div>
              </div>
            </div>

            <div className="premium-card">
              <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>⏱️ Время цикла по видам ремонта</h3>
              <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🛠️ Деповской ремонт (ДР) — {drStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '10px' }}>
                    <span>Медиана: <b>{drStats.medianHours} ч</b> ({drStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{drStats.p90Hours} ч</b> ({drStats.p90Days} дн)</span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🔄 Переоборудование (КРП) — {krpStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '10px' }}>
                    <span>Медиана: <b>{krpStats.medianHours} ч</b> ({krpStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{krpStats.p90Hours} ч</b> ({krpStats.p90Days} дн)</span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '4px' }}>
                    <span>🔧 Текущий ремонт (ТР) — {trStats.count} ваг.</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '10px' }}>
                    <span>Медиана: <b>{trStats.medianHours} ч</b> ({trStats.medianDays} дн)</span>
                    <span>90% вагонов: <b>{trStats.p90Hours} ч</b> ({trStats.p90Days} дн)</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="premium-card">
              <h3 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--danger)' }}>🚨 Структура потерь и задержек (Парето)</h3>
              {(Object.entries(lostWagonDays.byCategory) as [string, number][]).map(([cat, days]) => {
                const hours = Math.round(days * 24);
                const percent = Math.min(100, (days / (lostWagonDays.totalDays || 1)) * 100);
                const ruCat = CATEGORY_RU[cat] || cat;

                return (
                  <div key={cat} style={{ marginBottom: '10px', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 'bold', marginBottom: '4px' }}>
                      <span>{ruCat}</span>
                      <span style={{ color: 'var(--danger)' }}>{hours.toLocaleString()} ч ({days.toFixed(1)} дн)</span>
                    </div>
                    <div style={{ background: 'rgba(255,59,48,0.1)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ width: `${percent}%`, background: 'var(--danger)', height: '100%', borderRadius: '4px' }} />
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {percent.toFixed(1)}% от всех задержек депо
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
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Роль в БД: <b>{user?.role || 'GUEST'}</b> <br />{user?.role === 'ADMIN' && <span style={{color: 'var(--brand-color)'}}>Симуляция: {currentRoleInfo?.label}</span>}</p>
            </div>
            {user?.role === 'ADMIN' ? (
              <>
                <div className="premium-card" style={{ borderLeft: '4px solid var(--brand-color)' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--brand-color)' }}>🔑 Режим тестирования ролей (Админ)</h4>
                  <select className="select-field" style={{ margin: 0, fontSize: '12px', fontWeight: 'bold' }} value={activeRole} onChange={e => handleRoleChange(e.target.value)}>
                    {ROLES_LIST.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </div>
                <div className="premium-card">
                  <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: 'var(--brand-color)' }}>⚙️ Персонал и Нормативы ремонта цехов</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {Object.entries(shopMasters).map(([key, val]) => (
                      <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--brand-color)' }}>{val.label}</span>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', flex: '1 1 110px' }} type="text" value={val.master} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, master: e.target.value } })} placeholder="ФИО" />
                          <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', flex: '1 1 90px' }} type="text" value={val.tg} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, tg: e.target.value } })} placeholder="@username" />
                          {key !== 'procurement' && key !== 'mechanic' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 90px' }}>
                              <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', width: '50px' }} type="number" step="0.5" value={val.targetHours} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, targetHours: Number(e.target.value) } })} placeholder="Норма" />
                              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ч.</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    <button className="btn-primary" style={{ marginTop: '4px' }} onClick={handleSaveMasters} disabled={loading}>💾 Сохранить персонал</button>
                  </div>
                </div>
              </>
            ) : (<div className="premium-card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>🔒 Панель управления доступна только Начальнику депо.</div>)}
          </div>
        )}
      </div>

      <nav className="bottom-nav">
        <button className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} onClick={() => setCurrentTab('home')}><div className="nav-icon">🏠</div><span>Главная</span></button>
        <button className={`nav-item ${currentTab === 'wagons' ? 'active' : ''}`} onClick={() => setCurrentTab('wagons')}><div className="nav-icon">🚆</div><span>Вагоны</span></button>
        <button className={`nav-item ${currentTab === 'analytics' ? 'active' : ''}`} onClick={() => setCurrentTab('analytics')}><div className="nav-icon">📊</div><span>Аналитика</span></button>
        <button className={`nav-item ${currentTab === 'profile' ? 'active' : ''}`} onClick={() => setCurrentTab('profile')}><div className="nav-icon">👤</div><span>Профиль</span></button>
      </nav>

      {/* Модалка: МАССОВАЯ ПРИЕМКА ВАГОНОВ */}
      {showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>🛡️ КПП: Приемка вагонов</h3>
            <textarea className="textarea-field" value={wagonNumbersInput} onChange={e => setWagonNumbersInput(e.target.value)} placeholder="Введите 8-значные номера вагонов (через пробел или с новой строки)" rows={3} />
            <div style={{ fontSize: '11px', color: parsedWagonsCount > 0 ? 'var(--brand-color)' : 'var(--text-muted)', fontWeight: 'bold', marginBottom: '8px', textAlign: 'right' }}>Распознано вагонов: {parsedWagonsCount} шт.</div>
            
            <select className="select-field" value={ownerType} onChange={e => setOwnerType(e.target.value)}>
              <option value="Own">Собственный</option>
              <option value="Third-party">Чужой</option>
            </select>

            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading || parsedWagonsCount === 0}>
                Зарегистрировать {parsedWagonsCount > 0 ? `(${parsedWagonsCount})` : ''}
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
                <h3 style={{ margin: 0, fontSize: '18px' }}>№ {selectedCase.wagons?.wagon_number}</h3>
                <span className="status-pill" style={{ color: 'var(--brand-color)' }}>{STATUS_RU[selectedCase.current_status] || selectedCase.current_status}</span>
              </div>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'transparent', border: 'none', fontSize: '16px' }}>✕</button>
            </div>

            <div className="premium-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--brand-color)', fontWeight: 'bold' }}>
                  📅 Дата захода в депо: {new Date(selectedCase.created_at).toLocaleString('ru-RU')}
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', width: '90px' }}>Вид ремонта:</span>
                  <select 
                    className="select-field" 
                    style={{ margin: 0, padding: '4px 8px', fontSize: '11px', flex: 1 }} 
                    value={selectedCase.repair_type || 'ДР'} 
                    disabled={!isAdminOrOperator || loading}
                    onChange={async (e) => {
                      const newType = e.target.value;
                      setLoading(true);
                      const { error } = await supabase.rpc('update_repair_type', { p_repair_id: selectedCase.repair_id, p_repair_type: newType, p_user_id: user?.id });
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
                        p_user_id: user?.id 
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
                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>🏗️ Этапы ремонта и Ответственные цехов</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {DEFAULT_SHOPS.map(s => {
                    const prog = selectedCase.shop_progress?.[s.key] || { status: 'PENDING' };
                    const masterInfo = shopMasters[s.key] || { master: 'Мастер', tg: '@master', targetHours: 4 };
                    const isInProgress = prog.status === 'IN_PROGRESS';
                    const isDone = prog.status === 'DONE';
                    const canEdit = canPerformAction(s.key);
                    const timeInfo = renderShopTimeInfo(prog.start_at, prog.end_at, masterInfo.targetHours);

                    return (
                      <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: isInProgress ? 'rgba(0, 122, 255, 0.08)' : 'var(--bg-color)', borderLeft: isInProgress ? '3px solid var(--brand-color)' : 'none', padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>
                        <div>
                          <div style={{ fontWeight: 'bold' }}>{s.label}
                            <span style={{ color: timeInfo.isOverdue ? 'var(--danger)' : isInProgress ? 'var(--brand-color)' : 'var(--text-muted)', fontSize: '10px', marginLeft: '4px', fontWeight: timeInfo.isOverdue ? 'bold' : 'normal' }}>
                              ({isInProgress ? 'В работе: ' : isDone ? 'Итого: ' : ''}{timeInfo.text}){timeInfo.isOverdue && ' ⚠️ Превышение!'}
                            </span>
                          </div>
                          <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>Ответственный: <b>{masterInfo.master}</b> (<a href={`https://t.me/${masterInfo.tg.replace('@', '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-color)', textDecoration: 'none' }}>{masterInfo.tg}</a>)</div>
                        </div>
                        <div>
                          {isDone ? (
                            <span style={{ color: 'var(--success)', fontWeight: 'bold', fontSize: '10px' }}>✓ Готово</span>
                          ) : isInProgress ? (
                            canEdit ? <button className="btn-primary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto' }} onClick={() => handleUpdateShopStage(s.key, 'DONE')} disabled={loading}>Завершить</button> : <span style={{ color: 'var(--brand-color)', fontSize: '10px', fontWeight: 'bold' }}>▶ В работе</span>
                          ) : (
                            canEdit ? <button className="btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto' }} onClick={() => handleUpdateShopStage(s.key, 'IN_PROGRESS')} disabled={loading}>Начать</button> : <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>⏳ Ожидает</span>
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
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>📝 ШАГ 1. Комиссионный Акт (ВУ-22)</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {DEFAULT_SHOPS.map(s => {
                      const sig = selectedCase.shop_signatures?.[s.key];
                      const masterInfo = shopMasters[s.key] || { master: 'Мастер', tg: '@master' };
                      const canEdit = canPerformAction(s.key);
                      return (
                        <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>
                          <div>
                            <b>{s.label}</b>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>Ответственный: <b>{sig?.master_name || masterInfo.master}</b> ({masterInfo.tg}){sig?.signed_at && ` • ${new Date(sig.signed_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}</div>
                          </div>
                          {sig?.signed ? <span style={{ color: 'var(--success)', fontWeight: 'bold' }}>✓ Подписано</span> : (canEdit ? <button className="btn-primary" style={{ width: 'auto', padding: '4px 8px', fontSize: '10px' }} onClick={() => handleSignAct(s.key)} disabled={loading}>Подписать</button> : <span style={{ color: 'var(--warning)', fontSize: '10px' }}>⏳ Ожидает</span>)}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>🏗️ ШАГ 2. Размещение вагона</h4>
                  {selectedCase.track_number ? <div style={{ fontSize: '11px', color: 'var(--success)', marginBottom: '8px', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>📍 Завезён на: <b>{selectedCase.track_number}, {selectedCase.position_number}</b></div> : <div style={{ fontSize: '11px', color: 'var(--warning)', marginBottom: '8px', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>⏳ Находится в очереди с <b>{new Date(selectedCase.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b></div>}
                  {!allSigned && <div style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '8px' }}>⚠️ Завоз доступен после подписи акта всеми мастерами.</div>}
                  
                  {isAdminOrOperator && (
                    <>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                        <select className="select-field" style={{ margin: 0 }} value={track} onChange={e => setTrack(e.target.value)}><option value="Путь 1">Путь №1</option><option value="Путь 2">Путь №2</option></select>
                        <select className="select-field" style={{ margin: 0 }} value={position} onChange={e => setPosition(e.target.value)}><option value="Позиция 1">Позиция 1</option><option value="Позиция 2">Позиция 2</option><option value="Позиция 3">Позиция 3</option></select>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn-secondary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(false)} disabled={loading || !allSigned}>⏳ В очередь</button>
                        <button className="btn-primary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(true)} disabled={loading || !allSigned}>➡️ Завезти на путь</button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {selectedMetrics && (
                  <div className="premium-card">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>⏱️ Анализ времени простоя</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px' }}>
                      <div>Всего в депо: <b>{selectedMetrics.total_dwell_hours} ч</b></div><div>В очереди: <b>{selectedMetrics.queue_hours} ч</b></div>
                      <div>Общий ремонт: <b>{selectedMetrics.gross_repair_hours} ч</b></div><div>Задержки: <b style={{ color: 'var(--danger)' }}>{selectedMetrics.paused_hours} ч</b></div>
                    </div>
                    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border-light)', fontSize: '11px', display: 'flex', justifyContent: 'space-between' }}><span>Чистый ремонт:</span><b style={{ color: 'var(--success)' }}>{selectedMetrics.net_repair_hours} ч</b></div>
                  </div>
                )}
                
                {visibleTransitions.length > 0 && (
                  <div className="premium-card">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }}>Допустимые действия:</h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {visibleTransitions.map((st: string) => <button key={st} disabled={loading} onClick={() => handleUpdateStatus(st)} className="btn-primary" style={{ padding: '6px 10px', fontSize: '11px', width: 'auto', background: st === CASE_STATUS.PAUSED ? 'var(--danger)' : 'var(--brand-color)' }}>{st === CASE_STATUS.PAUSED ? '⛔ Сообщить о задержке' : `→ ${STATUS_RU[st] || st}`}</button>)}
                    </div>
                  </div>
                )}

                <div className="premium-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}><h4 style={{ margin: 0, fontSize: '13px', color: 'var(--brand-color)' }}>📄 Документы и Акты</h4></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                    {documents.map((d: any) => (
                      <div key={d.id || d.created_at} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '8px', fontSize: '11px' }}><span><b>{d.doc_type}</b> №{d.doc_number}</span><span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{d.doc_date || ''}</span></div>
                    ))}
                  </div>
                  {isAdminOrDocs && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <select className="select-field" style={{ margin: 0, flex: 1.2 }} value={docType} onChange={e => setDocType(e.target.value)}>{DOCUMENT_TYPES.map(dt => <option key={dt} value={dt}>{dt}</option>)}</select>
                      <input className="input-field" style={{ margin: 0, flex: 0.8 }} type="text" placeholder="№ док." value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                      <button className="btn-primary" style={{ width: 'auto', padding: '0 12px' }} onClick={handleAddDocument} disabled={loading}>+</button>
                    </div>
                  )}
                </div>
                
                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', color: 'var(--text-muted)' }}>📜 Журнал событий</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {statusHistory.map((ev: any) => (
                      <div key={ev.event_id || ev.event_datetime} style={{ fontSize: '10px', padding: '6px', background: 'var(--bg-color)', borderRadius: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}><span>{STATUS_RU[ev.new_status] || ev.new_status}</span><span style={{ color: 'var(--brand-color)', fontWeight: 'normal' }}>👤 {ev.users?.name || 'Система'}</span></div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '9px', marginTop: '2px' }}>{new Date(ev.event_datetime).toLocaleString()}</div>
                        {ev.comment && <div style={{ fontStyle: 'italic', marginTop: '2px', color: 'var(--text-main)' }}>{ev.comment}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Модалка задержки */}
      {showDelayModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', color: 'var(--danger)', fontSize: '15px' }}>⛔ Регистрация задержки</h3>
            
            <select className="select-field" value={delayType} onChange={e => setDelayType(e.target.value as any)}>
              <option value="PRIMARY">Основная задержка</option>
              <option value="SECONDARY">Сопутствующая задержка</option>
            </select>
            
            <select className="select-field" value={delayCategory} onChange={e => {
                const cat = e.target.value; setDelayCategory(cat);
                if (cat === 'Materials') { const info = shopMasters.procurement; setResponsibleParty(info ? `${info.master} (${info.tg})` : 'Отдел снабжения / Закупки'); } 
                else if (cat === 'Equipment') { const info = shopMasters.mechanic; setResponsibleParty(info ? `${info.master} (${info.tg})` : 'Начальник цеха'); } 
                else { setResponsibleParty(''); }
              }}>
              <option value="Materials">Материалы / Запчасти</option><option value="Equipment">Поломка оборудования</option><option value="Customer">Заказчик</option><option value="Railway">ЖД</option>
            </select>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={2} placeholder="Причина задержки" />
            <input className="input-field" type="text" value={responsibleParty} onChange={e => setResponsibleParty(e.target.value)} placeholder="Ответственный (ФИО)" />
            <input className="input-field" type="text" value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder="Следующее действие" />
            <input className="input-field" type="date" value={actionDeadline} onChange={e => setActionDeadline(e.target.value)} placeholder="Срок устранения (дедлайн)" />

            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}><button className="btn-secondary" onClick={() => setShowDelayModal(false)}>Отмена</button><button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={handleConfirmDelay} disabled={loading}>Заблокировать</button></div>
          </div>
        </div>
      )}
    </div>
  );
}