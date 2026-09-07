import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import { 
  STATUS_RU, ALLOWED_TRANSITIONS, ON_SITE_STATUSES,
  runDataQualityChecks, calculateLostWagonDays, calculateCyclePercentiles,
  type DQViolation, type RepairTimeMetrics 
} from './depoEngine';
import { 
  notifyWagonArrived, notifyActSigned, notifyPositionAssigned, 
  notifyShopStageUpdated, notifyDelayRegistered, notifyStatusChanged 
} from './telegramNotifier';
import './App.css';

declare global { interface Window { Telegram: any; } }

// --- ТИПИЗАЦИЯ (TypeScript Interfaces) ---
type AppTab = 'home' | 'wagons' | 'analytics' | 'profile';

export const CASE_STATUS = {
  PLANNED: '01 PLANNED',
  QUEUE: '04 QUEUE',
  IN_REPAIR: '07 IN_REPAIR',
  PAUSED: '08 REPAIR_PAUSED',
  READY: '11 READY_TO_DISPATCH'
} as const;

interface Wagon {
  wagon_number: string;
  owner: string;
  owner_type: string;
}

interface Contract {
  customer_name: string;
  sla_hours: number;
}

interface RepairCase {
  repair_id: string;
  current_status: string;
  repair_type: string;
  created_at: string;
  sla_deadline: string | null;
  planned_release: string | null;
  forecast_release: string | null;
  track_number: string | null;
  position_number: string | null;
  shop_signatures: Record<string, any>;
  shop_progress: Record<string, any>;
  current_shop: string | null;
  contracts: Contract | any;
  wagons: Wagon | any;
}

interface DelayLog {
  id: string;
  repair_id: string;
  category: string;
  delay_type: string;
  cause: string;
  responsible_party: string;
  start_datetime: string;
  end_datetime: string | null;
  next_action: string | null;
}

interface ShopMasterConfig {
  label: string;
  master: string;
  tg: string;
  role: string;
  targetHours: number;
}

const DOCUMENT_TYPES = [
  'Справка ВУ 36М',
  'АКТ ВУ-23 (Ремонт завершен)',
  'АКТ ВУ-22 (Дефектная ведомость)',
  'Справка 2612',
  'Справка 2602',
  'Акт дефектации'
];

const DEFAULT_SHOPS = [
  { key: 'bogie', label: 'Тележечный цех' },
  { key: 'wheels', label: 'Колёсный цех' },
  { key: 'brakes', label: 'Автотормозной цех' },
  { key: 'body', label: 'Кузовной / Сварочный' }
];

const TRACKS_CONFIG = [
  { track: 'Путь 1', positions: ['Позиция 1', 'Позиция 2', 'Позиция 3'] },
  { track: 'Путь 2', positions: ['Позиция 1', 'Позиция 2', 'Позиция 3'] }
];

const ROLES_LIST = [
  { key: 'ADMIN', label: '👑 Начальник депо / Диспетчер (Полный доступ)' },
  { key: 'bogie', label: '🔧 Мастер Тележечного цеха' },
  { key: 'wheels', label: '⚙️ Мастер Колёсного цеха' },
  { key: 'brakes', label: '🛑 Мастер Автотормозного цеха' },
  { key: 'body', label: '🔨 Мастер Кузовного цеха' },
  { key: 'docs', label: '📄 Оформитель актов (Делопроизводитель)' }
];

export default function App() {
  const [user, setUser] = useState<{ id: string; name: string; role: string; telegram_id?: string } | null>(null);
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [activeRole, setActiveRole] = useState<string>('ADMIN');
  const [showAddModal, setShowAddModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const [repairs, setRepairs] = useState<RepairCase[]>([]);
  const [delayLogs, setDelayLogs] = useState<DelayLog[]>([]);
  const [timeMetricsList, setTimeMetricsList] = useState<RepairTimeMetrics[]>([]);
  const [dqViolations, setDqViolations] = useState<DQViolation[]>([]);
  
  const [shopMasters, setShopMasters] = useState<Record<string, ShopMasterConfig>>({
    bogie: { label: 'Тележечный цех', master: 'Иванов И.И.', tg: '@master_bogie', role: 'MASTER', targetHours: 4 },
    wheels: { label: 'Колёсный цех', master: 'Петров П.П.', tg: '@master_wheels', role: 'MASTER', targetHours: 3 },
    brakes: { label: 'Автотормозной цех', master: 'Сидоров С.С.', tg: '@master_brakes', role: 'MASTER', targetHours: 2 },
    body: { label: 'Кузовной / Сварочный', master: 'Кузнецов К.К.', tg: '@master_body', role: 'MASTER', targetHours: 5 },
    docs: { label: 'Оформитель актов (ВУ-22 / ВУ-36М)', master: 'Анна Сергеевна', tg: '@depo_docs_clerk', role: 'CLERK', targetHours: 1 }
  });

  const [selectedCase, setSelectedCase] = useState<RepairCase | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<RepairTimeMetrics | null>(null);
  const [statusHistory, setStatusHistory] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [docType, setDocType] = useState(DOCUMENT_TYPES[0]);
  const [docNumber, setDocNumber] = useState('');
  const [loading, setLoading] = useState(false);

  // Формы задержек
  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayType, setDelayType] = useState<'PRIMARY' | 'SECONDARY'>('PRIMARY');
  const [delayCause, setDelayCause] = useState('');
  const [responsibleParty, setResponsibleParty] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [actionDeadline, setActionDeadline] = useState('');

  // Формы регистрации
  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [repairType, setRepairType] = useState('ДР');
  const [owner, setOwner] = useState('ПРОМТРАНС');
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
      if (tg) {
        tg.ready(); tg.expand(); tg.setHeaderColor?.('bg_color');
        tgUser = tg.initDataUnsafe?.user;
      }
    } catch (e) {}

    if (tgUser?.id) {
      const { data: dbUser } = await supabase.from('users').select('*').eq('telegram_id', tgUser.id).maybeSingle();
      if (dbUser) {
        setUser(dbUser);
        setActiveRole(dbUser.role || 'ADMIN');
      } else {
        const { data: newUser } = await supabase.from('users').insert([{ telegram_id: tgUser.id, name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(), role: 'ADMIN' }]).select().single();
        setUser(newUser);
        setActiveRole('ADMIN');
      }
    } else {
      setUser({ id: '00000000-0000-0000-0000-000000000000', name: 'Владимир', role: 'ADMIN' });
      setActiveRole('ADMIN');
    }
    loadData();
  }

  async function loadData() {
    const { data: repairData } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, sla_deadline, planned_release, forecast_release,
        track_number, position_number, shop_signatures, shop_progress, current_shop,
        contracts ( customer_name, sla_hours ),
        wagons ( wagon_number, owner, owner_type )
      `).order('created_at', { ascending: false });

    const { data: delays } = await supabase.from('delay_log').select('*').order('start_datetime', { ascending: false });
    const { data: metrics } = await supabase.from('v_repair_time_metrics').select('*');

    const { data: mastersData } = await supabase.from('shop_masters').select('*');
    if (mastersData && mastersData.length > 0) {
      const mapped: Record<string, ShopMasterConfig> = {};
      mastersData.forEach((m: any) => {
        mapped[m.shop_key] = { 
          label: m.shop_name, 
          master: m.master_name,
          tg: m.telegram_handle || '@master',
          role: m.role_code || 'MASTER',
          targetHours: Number(m.target_hours || 4)
        };
      });
      setShopMasters(mapped);
    }

    if (metrics) setTimeMetricsList(metrics);
    if (repairData) {
      setRepairs(repairData as unknown as RepairCase[]);
      setDelayLogs(delays as DelayLog[] || []);
      setDqViolations(runDataQualityChecks(repairData, delays || []));
    }
  }

  async function handleRoleChange(newRole: string) {
    setActiveRole(newRole);
    vibrate('medium');
    if (user?.id) {
      await supabase.from('users').update({ role: newRole }).eq('id', user.id);
      setUser((prev) => prev ? { ...prev, role: newRole } : null);
    }
  }

  const canPerformAction = (targetShopKey: string) => activeRole === 'ADMIN' || activeRole === targetShopKey;

  // --- УТИЛИТЫ ---
  const getMasterLabel = (shopKey: string) => {
    const info = shopMasters[shopKey];
    return info ? `${info.master} (${info.tg})`.trim() : 'Мастер';
  };

  const escapeCsvCell = (str: any) => {
    if (str == null) return '""';
    return `"${String(str).replace(/"/g, '""')}"`;
  };
  // ---------------

  async function handleSaveMasters() {
    setLoading(true); vibrate('heavy');
    for (const [key, val] of Object.entries(shopMasters)) {
      await supabase.from('shop_masters').upsert({
        shop_key: key, shop_name: val.label, master_name: val.master, telegram_handle: val.tg,
        role_code: val.role, target_hours: val.targetHours, updated_at: new Date().toISOString()
      });
    }
    alert('Персонал, нормативы и Telegram-аккаунты сохранены!');
    setLoading(false);
    loadData();
  }

  async function openCaseDetails(item: RepairCase) {
    vibrate('light');
    setSelectedCase(item);
    
    const { data: timeMetrics } = await supabase.from('v_repair_time_metrics').select('*').eq('repair_id', item.repair_id).maybeSingle();
    if (timeMetrics) {
      const gross = Math.max(0, Number(timeMetrics.gross_repair_hours || 0));
      const paused = Math.max(0, Number(timeMetrics.paused_hours || 0));
      setSelectedMetrics({
        total_dwell_hours: Number(Number(timeMetrics.total_dwell_hours || 0).toFixed(1)),
        queue_hours: Number(Number(timeMetrics.queue_hours || 0).toFixed(1)),
        gross_repair_hours: Number(gross.toFixed(1)),
        paused_hours: Number(paused.toFixed(1)),
        net_repair_hours: Number(Math.max(0, gross - paused).toFixed(1))
      } as RepairTimeMetrics);
    } else {
      setSelectedMetrics(null);
    }

    const { data: events } = await supabase.from('status_events').select('*, users(name, role)').eq('repair_id', item.repair_id).order('event_datetime', { ascending: false });
    if (events) setStatusHistory(events);

    const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', item.repair_id).order('created_at', { ascending: false });
    setDocuments(docs || []);
  }

  async function handleCreateRepair() {
    if (!wagonNumber.trim() || wagonNumber.length !== 8) { alert('Введите 8-значный номер вагона'); return; }
    setLoading(true); vibrate('medium');
    
    const { error } = await supabase.rpc('create_repair_case', {
      p_wagon_number: wagonNumber, p_repair_type: repairType, p_user_id: user?.id,
      p_wagon_type: wagonType, p_owner: owner, p_owner_type: ownerType
    });
    
    if (!error) { 
      notifyWagonArrived(wagonNumber, repairType, owner, wagonType);
      setWagonNumber(''); setShowAddModal(false); loadData(); 
    } else { alert('Ошибка: ' + error.message); }
    setLoading(false);
  }

  async function handleSignAct(shopKey: string) {
    if (!canPerformAction(shopKey)) { alert(`⛔ Ошибка доступа: Подписать акт может только ${shopMasters[shopKey]?.label || 'мастер'} или Админ.`); return; }
    if (!selectedCase) return;
    setLoading(true);
    
    const signLabel = getMasterLabel(shopKey);
    const { data: updatedSigs, error } = await supabase.rpc('sign_defect_act', { p_repair_id: selectedCase.repair_id, p_shop_key: shopKey, p_user_name: signLabel, p_user_id: user?.id });
    
    if (!error) {
      notifyActSigned(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', signLabel);
      setSelectedCase({ ...selectedCase, shop_signatures: updatedSigs });
      loadData();
    } else { alert('Ошибка подписи: ' + error.message); }
    setLoading(false);
  }

  async function handleUpdateShopStage(shopKey: string, status: string) {
    if (!canPerformAction(shopKey)) { alert(`⛔ Ошибка доступа: Работы в цехе может отмечать только ${shopMasters[shopKey]?.label} или Админ.`); return; }
    if (!selectedCase) return;
    setLoading(true);

    const masterLabel = getMasterLabel(shopKey);
    const { data: updatedProgress, error } = await supabase.rpc('update_shop_stage', {
      p_repair_id: selectedCase.repair_id, p_shop_key: shopKey, p_status: status, p_master_name: masterLabel, p_user_id: user?.id
    });

    if (!error) {
      notifyShopStageUpdated(selectedCase.wagons?.wagon_number, shopMasters[shopKey]?.label || 'Цех', status, masterLabel);
      setSelectedCase({ ...selectedCase, shop_progress: updatedProgress, current_shop: shopKey });
      loadData();
    } else { alert('Ошибка обновления этапа: ' + error.message); }
    setLoading(false);
  }

  async function handleAssignPosition(toRepair: boolean) {
    if (activeRole !== 'ADMIN') { alert('⛔ Завезти вагон на путь или отправить в очередь может только Диспетчер / Админ.'); return; }
    if (!selectedCase) return;
    setLoading(true);
    
    const { error } = await supabase.rpc('assign_repair_position', {
      p_repair_id: selectedCase.repair_id, p_track: toRepair ? track : null, p_position: toRepair ? position : null, p_user_id: user?.id
    });
    
    if (!error) { 
      notifyPositionAssigned(selectedCase.wagons?.wagon_number, toRepair, track, position);
      setSelectedCase(null); loadData(); 
    } else { alert('Ошибка назначения позиции: ' + error.message); }
    setLoading(false);
  }

  async function handleAddDocument() {
    if (activeRole !== 'ADMIN' && activeRole !== 'docs') { alert('⛔ Подгружать документы может только Оформитель актов или Админ.'); return; }
    if (!docNumber.trim() || !selectedCase) { alert('Введите номер документа!'); return; }
    setLoading(true); vibrate('light');
    
    const { error } = await supabase.from('documents').insert([{
      repair_id: selectedCase.repair_id, doc_type: docType, doc_number: docNumber, doc_date: new Date().toISOString().split('T')[0]
    }]);
    
    if (!error) {
      setDocNumber('');
      const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', selectedCase.repair_id).order('created_at', { ascending: false });
      setDocuments(docs || []);
    }
    setLoading(false);
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!selectedCase) return;
    if (newStatus === CASE_STATUS.PAUSED) { setShowDelayModal(true); return; }
    setLoading(true); vibrate('medium');
    
    const { error } = await supabase.rpc('change_repair_status', {
      p_repair_id: selectedCase.repair_id, p_new_status: newStatus, p_user_id: user?.id, p_comment: `Переход на ${STATUS_RU[newStatus] || newStatus}`
    });
    
    if (!error) { 
      notifyStatusChanged(selectedCase.wagons?.wagon_number, STATUS_RU[newStatus] || newStatus);
      setSelectedCase(null); loadData(); 
    } else { alert('Ошибка смены статуса: ' + error.message); }
    setLoading(false);
  }

  async function handleConfirmDelay() {
    if (!delayCause.trim() || !nextAction.trim() || !responsibleParty.trim()) { alert('Заполните причину, ответственного и следующее действие!'); return; }
    setLoading(true); vibrate('heavy');
    
    const { error } = await supabase.rpc('register_delay', {
      p_repair_id: selectedCase?.repair_id, p_category: delayCategory, p_delay_type: delayType,
      p_cause: delayCause, p_responsible_party: responsibleParty, p_next_action: nextAction,
      p_action_deadline: actionDeadline ? new Date(actionDeadline).toISOString() : null, p_user_id: user?.id
    });
    
    if (!error) {
      notifyDelayRegistered(selectedCase?.wagons?.wagon_number || '', delayCategory, delayCause, responsibleParty, nextAction);
      setShowDelayModal(false); setSelectedCase(null); setDelayCause(''); setNextAction(''); setResponsibleParty(''); setActionDeadline(''); loadData();
    } else { alert('Ошибка добавления задержки: ' + error.message); }
    setLoading(false);
  }

  function exportToCSV() {
    const headers = ['Wagon Number', 'Status', 'Repair Type', 'Owner', 'SLA Deadline', 'Forecast Release'];
    const rows = filteredRepairs.map(r => [
      escapeCsvCell(r.wagons?.wagon_number), 
      escapeCsvCell(STATUS_RU[r.current_status] || r.current_status), 
      escapeCsvCell(r.repair_type), 
      escapeCsvCell(r.wagons?.owner),
      escapeCsvCell(r.sla_deadline ? new Date(r.sla_deadline).toLocaleString() : ''), 
      escapeCsvCell(r.forecast_release ? new Date(r.forecast_release).toLocaleString() : '')
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const link = document.createElement('a'); link.setAttribute('href', encodeURI(csvContent));
    link.setAttribute('download', `depo_wagons_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  }

  const onSiteRepairs = repairs.filter(r => ON_SITE_STATUSES.includes(r.current_status));
  const filteredRepairs = statusFilter ? repairs.filter(r => r.current_status === statusFilter) : repairs;
  const lostWagonDays = calculateLostWagonDays(delayLogs);
  const readyNotDispatched = repairs.filter(r => r.current_status === CASE_STATUS.READY);
  const forecastBreaches = repairs.filter(r => r.forecast_release && r.sla_deadline && new Date(r.forecast_release) > new Date(r.sla_deadline));
  
  const drHours = timeMetricsList.filter(m => repairs.find(r => r.repair_id === (m as any).repair_id)?.repair_type === 'ДР').map(m => Number(m.total_dwell_hours || 0));
  const krHours = timeMetricsList.filter(m => repairs.find(r => r.repair_id === (m as any).repair_id)?.repair_type === 'КР').map(m => Number(m.total_dwell_hours || 0));
  const drCycle = calculateCyclePercentiles(drHours);
  const krCycle = calculateCyclePercentiles(krHours);

  const availableTransitions = selectedCase ? (ALLOWED_TRANSITIONS[selectedCase.current_status] || []) : [];
  const isInitialPhase = selectedCase && [CASE_STATUS.PLANNED, CASE_STATUS.QUEUE].includes(selectedCase.current_status as any);
  const allSigned = selectedCase?.shop_signatures && DEFAULT_SHOPS.every(s => selectedCase.shop_signatures[s.key]?.signed);

  const renderShopTimeInfo = (startAt: string | null, endAt: string | null, targetHours: number) => {
    const startTime = startAt ? new Date(startAt).getTime() : null;
    const endTime = endAt ? new Date(endAt).getTime() : new Date().getTime();
    if (!startTime) return { text: `Норма: ${targetHours} ч`, isOverdue: false };
    const hoursSpent = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
    const isOverdue = hoursSpent > targetHours;
    const timeFormatted = hoursSpent < 1 ? `${Math.round(hoursSpent * 60)} мин` : `${hoursSpent.toFixed(1)} ч`;
    return { text: `${timeFormatted} / Норма: ${targetHours} ч`, isOverdue };
  };

  const currentRoleInfo = ROLES_LIST.find(r => r.key === activeRole);

  return (
    <div>
      <header className="brand-header">
        <h1 className="brand-title">ДЕПО TMS</h1>
        <span className="status-pill">{user?.name}</span>
      </header>

      <div className="content-area">
        {currentTab === 'home' && (
          <>
            {(dqViolations.length > 0 || forecastBreaches.length > 0 || readyNotDispatched.length > 0) && (
              <div className="premium-card" style={{ borderLeft: '4px solid var(--danger)', background: 'rgba(255, 59, 48, 0.05)' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger)', fontSize: '13px' }}>🚨 Требуют внимания диспетчера</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                  {forecastBreaches.length > 0 && <div><b>⚠️ Риск срыва SLA:</b> {forecastBreaches.length} ваг. (Прогноз &gt; SLA)</div>}
                  {readyNotDispatched.length > 0 && <div><b>🚂 Ожидают отправки:</b> {readyNotDispatched.length} ваг.</div>}
                  {dqViolations.map((v, i) => <div key={i}><b>Вагон №{v.wagon_number}:</b> {v.message}</div>)}
                </div>
              </div>
            )}

            <h3 style={{ margin: '12px 0 6px 0', fontSize: '16px' }}>На территории депо: {onSiteRepairs.length}</h3>
            
            <div className="stats-grid">
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.QUEUE); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--warning)' }}>В очереди</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.QUEUE).length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.IN_REPAIR); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--brand-color)' }}>В ремонте</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.IN_REPAIR).length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.PAUSED); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--danger)' }}>Задержано</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === CASE_STATUS.PAUSED).length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter(CASE_STATUS.READY); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--success)' }}>Готовы</span>
                <span className="stat-value">{readyNotDispatched.length}</span>
              </div>
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

            <div className="premium-card">
              <h4 style={{ margin: '0 0 4px 0', fontSize: '13px' }}>Потери: <b>{lostWagonDays.totalDays} wagon-days</b></h4>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Рассчитано только по PRIMARY задержкам</span>
            </div>
          </>
        )}

        {currentTab === 'wagons' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '16px' }}>{statusFilter ? `Фильтр: ${STATUS_RU[statusFilter]}` : 'Все вагоны'}</h3>
              <div style={{ display: 'flex', gap: '6px' }}>
                {statusFilter && <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={() => setStatusFilter(null)}>Сброс</button>}
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={exportToCSV}>💾 Excel</button>
              </div>
            </div>

            {filteredRepairs.map((item) => {
              const isBreached = item.forecast_release && item.sla_deadline && new Date(item.forecast_release) > new Date(item.sla_deadline);
              const activeDelay = delayLogs.find(d => d.repair_id === item.repair_id && !d.end_datetime);

              return (
                <div key={item.repair_id} className="premium-card" onClick={() => openCaseDetails(item)} style={{ borderLeft: isBreached ? '4px solid var(--danger)' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <span style={{ fontSize: '15px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
                    <span className="status-pill">{STATUS_RU[item.current_status] || item.current_status}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{item.repair_type} • {item.wagons?.owner}</span>
                    <span style={{ color: isBreached ? 'var(--danger)' : 'var(--text-muted)', fontWeight: isBreached ? 'bold' : 'normal' }}>
                      {isBreached ? '⚠️ Риск SLA' : (item.track_number ? `${item.track_number}, ${item.position_number}` : 'Не назначен')}
                    </span>
                  </div>
                  {activeDelay && (
                    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed var(--border-light)', fontSize: '10px', color: 'var(--danger)' }}>
                      <div><b>⛔ {activeDelay.category}:</b> {activeDelay.cause}</div>
                    </div>
                  )}
                </div>
              );
            })}
            <button className="fab" onClick={() => setShowAddModal(true)}>+</button>
          </>
        )}

        {currentTab === 'analytics' && (
          <>
            <div className="premium-card">
              <h3 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>⏱️ Цикл ремонта (Dwell Time)</h3>
              <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>
                  <span><b>Деповской ремонт (ДР):</b></span><span>Медиана: <b>{drCycle.median} дн</b> | P90: <b>{drCycle.p90} дн</b></span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>
                  <span><b>Капитальный ремонт (КР):</b></span><span>Медиана: <b>{krCycle.median} дн</b> | P90: <b>{krCycle.p90} дн</b></span>
                </div>
              </div>
            </div>
            <div className="premium-card">
              <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>Аналитика потерь (Pareto)</h3>
              {(Object.entries(lostWagonDays.byCategory) as [string, number][]).map(([cat, days]) => (
                <div key={cat} style={{ marginBottom: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
                    <span><b>{cat}</b></span><span>{days.toFixed(1)} вагон-дней</span>
                  </div>
                  <div style={{ background: 'var(--bg-color)', height: '6px', borderRadius: '3px' }}>
                    <div style={{ width: `${Math.min(100, (days / (lostWagonDays.totalDays || 1)) * 100)}%`, background: 'var(--danger)', height: '100%', borderRadius: '3px' }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {currentTab === 'profile' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="premium-card" style={{ textAlign: 'center' }}>
              <h3 style={{ margin: '0 0 4px 0' }}>{user?.name}</h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Системная роль: <b>{user?.role || 'GUEST'}</b> ({currentRoleInfo?.label})
              </p>
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
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 90px' }}>
                            <input className="input-field" style={{ margin: 0, padding: '6px 8px', fontSize: '11px', width: '50px' }} type="number" step="0.5" value={val.targetHours} onChange={e => setShopMasters({ ...shopMasters, [key]: { ...val, targetHours: Number(e.target.value) } })} placeholder="Норма" />
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ч.</span>
                          </div>
                        </div>
                      </div>
                    ))}
                    <button className="btn-primary" style={{ marginTop: '4px' }} onClick={handleSaveMasters} disabled={loading}>💾 Сохранить персонал</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="premium-card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
                🔒 Управление персоналом доступно только Начальнику депо.
              </div>
            )}
          </div>
        )}
      </div>

      <nav className="bottom-nav">
        <button className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} onClick={() => setCurrentTab('home')}><div className="nav-icon">🏠</div><span>Главная</span></button>
        <button className={`nav-item ${currentTab === 'wagons' ? 'active' : ''}`} onClick={() => setCurrentTab('wagons')}><div className="nav-icon">🚆</div><span>Вагоны</span></button>
        <button className={`nav-item ${currentTab === 'analytics' ? 'active' : ''}`} onClick={() => setCurrentTab('analytics')}><div className="nav-icon">📊</div><span>Аналитика</span></button>
        <button className={`nav-item ${currentTab === 'profile' ? 'active' : ''}`} onClick={() => setCurrentTab('profile')}><div className="nav-icon">👤</div><span>Профиль</span></button>
      </nav>

      {/* Модалка: Регистрация вагона */}
      {showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>Регистрация вагона</h3>
            <input className="input-field" type="number" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="Номер вагона (8 цифр)" />
            <select className="select-field" value={wagonType} onChange={e => setWagonType(e.target.value)}><option>Полувагон</option><option>Цистерна</option><option>Платформа</option><option>Крытый</option><option>Переоборудованный</option></select>
            <select className="select-field" value={repairType} onChange={e => setRepairType(e.target.value)}><option>КР</option><option>ДР</option><option>ТР</option><option>КРП</option><option>ДРП</option></select>
            <input className="input-field" type="text" value={owner} onChange={e => setOwner(e.target.value)} placeholder="Собственник" />
            <select className="select-field" value={ownerType} onChange={e => setOwnerType(e.target.value)}><option value="Own">Собственный</option><option value="Third-party">Сторонний</option></select>
            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading}>Создать</button>
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
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 'bold' }}>Вид ремонта:</span>
                <select className="select-field" style={{ margin: 0, padding: '4px 8px', fontSize: '11px', flex: 1 }} value={selectedCase.repair_type || 'ДР'} onChange={async (e) => {
                    const newType = e.target.value;
                    setSelectedCase({ ...selectedCase, repair_type: newType });
                    await supabase.from('repair_cases').update({ repair_type: newType }).eq('repair_id', selectedCase.repair_id);
                    loadData();
                  }}>
                  <option value="КР">КР (Капитальный)</option><option value="ДР">ДР (Деповской)</option><option value="ТР">ТР (Текущий)</option><option value="КРП">КРП (С продлением)</option><option value="ДРП">ДРП (Деповской с продлением)</option>
                </select>
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
                    const isCurrent = selectedCase.current_shop === s.key || prog.status === 'IN_PROGRESS';
                    const isDone = prog.status === 'DONE';
                    const canEdit = canPerformAction(s.key);
                    const timeInfo = renderShopTimeInfo(prog.start_at, prog.end_at, masterInfo.targetHours);

                    return (
                      <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: isCurrent ? 'rgba(0, 122, 255, 0.08)' : 'var(--bg-color)', borderLeft: isCurrent ? '3px solid var(--brand-color)' : 'none', padding: '6px 10px', borderRadius: '6px', fontSize: '11px', opacity: canEdit ? 1 : 0.65 }}>
                        <div>
                          <div style={{ fontWeight: 'bold' }}>{s.label}
                            <span style={{ color: timeInfo.isOverdue ? 'var(--danger)' : isCurrent ? 'var(--brand-color)' : 'var(--text-muted)', fontSize: '10px', marginLeft: '4px', fontWeight: timeInfo.isOverdue ? 'bold' : 'normal' }}>
                              ({isCurrent ? 'В работе: ' : isDone ? 'Итого: ' : ''}{timeInfo.text}){timeInfo.isOverdue && ' ⚠️ Превышение!'}
                            </span>
                          </div>
                          <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Ответственный: <b>{masterInfo.master}</b> (<a href={`https://t.me/${masterInfo.tg.replace('@', '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-color)', textDecoration: 'none' }}>{masterInfo.tg}</a>)
                          </div>
                        </div>
                        <div>
                          {isDone ? <span style={{ color: 'var(--success)', fontWeight: 'bold', fontSize: '10px' }}>✓ Готово</span> : isCurrent ? <button className="btn-primary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto', background: canEdit ? 'var(--brand-color)' : '#aaa' }} onClick={() => handleUpdateShopStage(s.key, 'DONE')} disabled={loading || !canEdit}>{canEdit ? 'Завершить' : '🔒'}</button> : <button className="btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', width: 'auto' }} onClick={() => handleUpdateShopStage(s.key, 'IN_PROGRESS')} disabled={loading || !canEdit}>{canEdit ? 'Начать' : '🔒'}</button>}
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
                        <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px', opacity: canEdit ? 1 : 0.65 }}>
                          <div>
                            <b>{s.label}</b>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                              Ответственный: <b>{sig?.master_name || masterInfo.master}</b> ({masterInfo.tg})
                              {sig?.signed_at && ` • ${new Date(sig.signed_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
                            </div>
                          </div>
                          {sig?.signed ? <span style={{ color: 'var(--success)', fontWeight: 'bold' }}>✓ Подписано</span> : <button className="btn-primary" style={{ width: 'auto', padding: '4px 8px', fontSize: '10px', background: canEdit ? 'var(--brand-color)' : '#aaa' }} onClick={() => handleSignAct(s.key)} disabled={loading || !canEdit}>{canEdit ? 'Подписать' : '🔒'}</button>}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>🏗️ ШАГ 2. Размещение вагона</h4>
                  {selectedCase.track_number ? <div style={{ fontSize: '11px', color: 'var(--success)', marginBottom: '8px', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>📍 Завезён на: <b>{selectedCase.track_number}, {selectedCase.position_number}</b></div> : <div style={{ fontSize: '11px', color: 'var(--warning)', marginBottom: '8px', background: 'var(--bg-color)', padding: '6px', borderRadius: '6px' }}>⏳ Находится в очереди с <b>{new Date(selectedCase.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b></div>}
                  {!allSigned && <div style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '8px' }}>⚠️ Завоз доступен после подписи акта всеми мастерами.</div>}
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                    <select className="select-field" style={{ margin: 0 }} value={track} onChange={e => setTrack(e.target.value)}><option value="Путь 1">Путь №1</option><option value="Путь 2">Путь №2</option></select>
                    <select className="select-field" style={{ margin: 0 }} value={position} onChange={e => setPosition(e.target.value)}><option value="Позиция 1">Позиция 1</option><option value="Позиция 2">Позиция 2</option><option value="Позиция 3">Позиция 3</option></select>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn-secondary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(false)} disabled={loading || !allSigned || activeRole !== 'ADMIN'}>⏳ В очередь</button>
                    <button className="btn-primary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(true)} disabled={loading || !allSigned || activeRole !== 'ADMIN'}>➡️ Завезти на путь</button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {selectedMetrics && (
                  <div className="premium-card">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>⏱️ Модель времени (Time Model)</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px' }}>
                      <div>Всего в депо: <b>{selectedMetrics.total_dwell_hours} ч</b></div>
                      <div>В очереди: <b>{selectedMetrics.queue_hours} ч</b></div>
                      <div>Грязный ремонт: <b>{selectedMetrics.gross_repair_hours} ч</b></div>
                      <div>Задержки: <b style={{ color: 'var(--danger)' }}>{selectedMetrics.paused_hours} ч</b></div>
                    </div>
                    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border-light)', fontSize: '11px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Чистый ремонт (Net):</span><b style={{ color: 'var(--success)' }}>{selectedMetrics.net_repair_hours} ч</b>
                    </div>
                  </div>
                )}
                <div className="premium-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }}>Допустимые действия (State Machine):</h4>
                  {availableTransitions.length === 0 ? <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Цепочка завершена</p> : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {availableTransitions.map((st: string) => <button key={st} disabled={loading} onClick={() => handleUpdateStatus(st)} className="btn-primary" style={{ padding: '6px 10px', fontSize: '11px', width: 'auto' }}>→ {STATUS_RU[st] || st}</button>)}
                    </div>
                  )}
                </div>
                <div className="premium-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}><h4 style={{ margin: 0, fontSize: '13px', color: 'var(--brand-color)' }}>📄 Документы и Акты</h4></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                    {documents.map((d: any) => (
                      <div key={d.id || d.created_at} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '8px', fontSize: '11px' }}>
                        <span><b>{d.doc_type}</b> №{d.doc_number}</span><span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{d.doc_date || ''}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select className="select-field" style={{ margin: 0, flex: 1.2 }} value={docType} onChange={e => setDocType(e.target.value)}>{DOCUMENT_TYPES.map(dt => <option key={dt} value={dt}>{dt}</option>)}</select>
                    <input className="input-field" style={{ margin: 0, flex: 0.8 }} type="text" placeholder="№ док." value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                    <button className="btn-primary" style={{ width: 'auto', padding: '0 12px' }} onClick={handleAddDocument} disabled={loading}>+</button>
                  </div>
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
            <select className="select-field" value={delayType} onChange={e => setDelayType(e.target.value as any)}><option value="PRIMARY">PRIMARY</option><option value="SECONDARY">SECONDARY</option></select>
            <select className="select-field" value={delayCategory} onChange={e => setDelayCategory(e.target.value)}><option value="Materials">Материалы / Запчасти</option><option value="Customer">Заказчик</option><option value="Railway">ЖД</option></select>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={2} placeholder="Причина задержки" />
            <input className="input-field" type="text" value={responsibleParty} onChange={e => setResponsibleParty(e.target.value)} placeholder="Ответственный (ФИО)" />
            <input className="input-field" type="text" value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder="Next Action" />
            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowDelayModal(false)}>Отмена</button>
              <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={handleConfirmDelay} disabled={loading}>Заблокировать</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}