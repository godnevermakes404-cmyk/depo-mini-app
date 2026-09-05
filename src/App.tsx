import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import './App.css';

declare global {
  interface Window {
    Telegram: any;
  }
}

const STATUSES = [
  '01 PLANNED', '02 ARRIVED', '04 QUEUE', '07 IN_REPAIR',
  '08 REPAIR_PAUSED', '12 REPAIR_DONE', '15 DEPARTED'
];
const DELAY_CATEGORIES = ['Materials', 'Customer', 'Railway', 'Internal', 'Technical', 'External'];
const SLA_HOURS: Record<string, number> = { 'ТОР': 24, 'ДР': 72, 'КР': 120, 'КРП': 144, 'Модернизация': 168 };
const SHOPS = [
  { id: 'telezhka', name: '🛠️ Тележечный цех' },
  { id: 'kolesa', name: '⚙️ Колёсный цех' },
  { id: 'malyarka', name: '🎨 Малярный цех' },
  { id: 'sborka', name: '🔩 Сборка и испытания' }
];

type UserRole = 'Dispatcher' | 'Master' | 'Inspector' | 'Customer';

export default function App() {
  const [user, setUser] = useState<{ name: string; role: UserRole; telegram_id?: number } | null>(null);
  const [tab, setTab] = useState<'ops' | 'analytics'>('ops');
  const [view, setView] = useState<'dashboard' | 'add_wagon'>('dashboard');
  
  const [selectedCase, setSelectedCase] = useState<any>(null);
  const [shopProgress, setShopProgress] = useState<Record<string, boolean>>({ telezhka: false, kolesa: false, malyarka: false, sborka: false });
  const [signatures, setSignatures] = useState<Record<string, boolean>>({ master: false, inspector: false, customer: false });
  
  const [inputDefects, setInputDefects] = useState('');
  const [materialUsage, setMaterialUsage] = useState('');

  const [activeDelay, setActiveDelay] = useState<any>(null);
  const [statusHistory, setStatusHistory] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  
  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [ownerType, setOwnerType] = useState('Own');
  const [repairType, setRepairType] = useState('ДР');
  const [loading, setLoading] = useState(false);

  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayCause, setDelayCause] = useState('');
  const [docType, setDocType] = useState('Справка 2612');
  const [docNumber, setDocNumber] = useState('');

  const [repairs, setRepairs] = useState<any[]>([]);
  const [delayLogs, setDelayLogs] = useState<any[]>([]);
  const [stats, setStats] = useState({ onSite: 0, inRepair: 0, inQueue: 0, blocked: 0 });

  // Функция для вибрации кнопок
  const vibrate = (style: 'light' | 'medium' | 'heavy' = 'light') => {
    try {
      if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.impactOccurred(style);
      }
    } catch (e) {}
  };

  useEffect(() => {
    initAuthAndData();
  }, []);

  async function initAuthAndData() {
    let tgUser: any = null;
    let userName = 'Неизвестный пользователь';
    try {
      const tg = window.Telegram?.WebApp || WebApp;
      if (tg) {
        tg.ready();
        tg.expand(); // Разворачиваем аппку на весь экран
        if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
          tgUser = tg.initDataUnsafe.user;
          userName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || userName;
        }
      }
    } catch (e) {}

    if (tgUser && tgUser.id) {
      const { data: dbUser } = await supabase.from('users').select('*').eq('telegram_id', tgUser.id).maybeSingle();
      if (dbUser) {
        setUser({ name: dbUser.name || userName, role: (dbUser.role as UserRole) || 'Dispatcher', telegram_id: tgUser.id });
      } else {
        const { data: newUser } = await supabase.from('users').insert([{ telegram_id: tgUser.id, name: userName, role: 'Dispatcher' }]).select().maybeSingle();
        setUser({ name: userName, role: (newUser?.role as UserRole) || 'Dispatcher', telegram_id: tgUser.id });
      }
    } else {
      setUser({ name: 'Разработчик (Браузер)', role: 'Dispatcher' });
    }
    loadData();
  }

  async function loadData() {
    const { data, error } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, sla_deadline, updated_at, shop_progress, signatures, input_defects, material_usage,
        wagons ( wagon_number, wagon_type, owner_type )
      `).order('created_at', { ascending: false });

    if (!error && data) {
      setRepairs(data);
      setStats({
        onSite: data.length,
        inRepair: data.filter((d: any) => d.current_status === '07 IN_REPAIR').length,
        inQueue: data.filter((d: any) => d.current_status === '04 QUEUE' || d.current_status === '01 PLANNED').length,
        blocked: data.filter((d: any) => d.current_status === '08 REPAIR_PAUSED').length
      });
    }
    const { data: delays } = await supabase.from('delay_log').select('*').order('start_datetime', { ascending: false });
    if (delays) setDelayLogs(delays);
  }

  async function openCaseDetails(item: any) {
    vibrate('light');
    setSelectedCase(item);
    setShopProgress(item.shop_progress || { telezhka: false, kolesa: false, malyarka: false, sborka: false });
    setSignatures(item.signatures || { master: false, inspector: false, customer: false });
    setInputDefects(item.input_defects || '');
    setMaterialUsage(item.material_usage || '');
    
    if (item.current_status === '08 REPAIR_PAUSED') {
      const { data: delay } = await supabase.from('delay_log').select('*').eq('repair_id', item.repair_id).is('end_datetime', null).order('start_datetime', { ascending: false }).maybeSingle();
      setActiveDelay(delay);
    } else { setActiveDelay(null); }

    const { data: events } = await supabase.from('status_events').select('*').eq('repair_id', item.repair_id).order('recorded_datetime', { ascending: false });
    if (events) setStatusHistory(events);

    const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', item.repair_id).order('created_at', { ascending: false });
    if (docs) setDocuments(docs);
  }

  const canEditOps = user?.role === 'Dispatcher' || user?.role === 'Master';
  const canSignMaster = user?.role === 'Dispatcher' || user?.role === 'Master';
  const canSignInspector = user?.role === 'Dispatcher' || user?.role === 'Inspector';
  const canSignCustomer = user?.role === 'Dispatcher' || user?.role === 'Customer';

  async function handleToggleShop(shopId: string) {
    if (!canEditOps || !selectedCase) return;
    vibrate('medium');
    const newProgress = { ...shopProgress, [shopId]: !shopProgress[shopId] };
    setShopProgress(newProgress);
    await supabase.from('repair_cases').update({ shop_progress: newProgress }).eq('repair_id', selectedCase.repair_id);
    const shopName = SHOPS.find(s => s.id === shopId)?.name;
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: selectedCase.current_status, comment: `Цех: ${shopName} - этап ${newProgress[shopId] ? 'выполнен' : 'отменен'} [${user?.name}]` }]);
    loadData();
  }

  async function handleToggleSignature(sigKey: 'master' | 'inspector' | 'customer') {
    if (!selectedCase) return;
    if (sigKey === 'master' && !canSignMaster) { alert('Только Мастер цеха!'); vibrate('heavy'); return; }
    if (sigKey === 'inspector' && !canSignInspector) { alert('Только Приёмщик ВК!'); vibrate('heavy'); return; }
    if (sigKey === 'customer' && !canSignCustomer) { alert('Только Заказчик!'); vibrate('heavy'); return; }

    vibrate('medium');
    const newSigs = { ...signatures, [sigKey]: !signatures[sigKey] };
    setSignatures(newSigs);
    await supabase.from('repair_cases').update({ signatures: newSigs }).eq('repair_id', selectedCase.repair_id);
    const sigNames: Record<string, string> = { master: 'Мастер цеха', inspector: 'Приёмщик ВК', customer: 'Представитель Заказчика' };
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: selectedCase.current_status, comment: `Согласование ВУ-36М: ${sigNames[sigKey]} ${newSigs[sigKey] ? 'подписал' : 'отозвал подпись'} [${user?.name}]` }]);

    if (newSigs.master && newSigs.inspector && newSigs.customer) {
      const autoDocNum = `36M-${selectedCase.wagons?.wagon_number}`;
      await supabase.from('documents').insert([{ repair_id: selectedCase.repair_id, doc_type: 'ВУ-36М', doc_number: autoDocNum, doc_date: new Date().toISOString().split('T')[0] }]);
      vibrate('heavy');
      alert(`Все 3 подписи получены! Акт ВУ-36М № ${autoDocNum} сформирован автоматически.`);
      openCaseDetails(selectedCase);
    }
    loadData();
  }

  async function handleSaveTechData() {
    if (!canEditOps || !selectedCase) return;
    setLoading(true);
    await supabase.from('repair_cases').update({ input_defects: inputDefects, material_usage: materialUsage }).eq('repair_id', selectedCase.repair_id);
    vibrate('light');
    setLoading(false);
    loadData();
  }

  async function handleCreateRepair() {
    if (!canEditOps) return;
    if (!wagonNumber.trim()) { alert('Введите номер вагона'); return; }
    vibrate('light');
    setLoading(true);
    try {
      let wagonId: string | null = null;
      const { data: existingWagon } = await supabase.from('wagons').select('id').eq('wagon_number', wagonNumber).maybeSingle();
      if (existingWagon) { wagonId = existingWagon.id; } 
      else {
        const { data: newWagon } = await supabase.from('wagons').insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner_type: ownerType }]).select().single();
        wagonId = newWagon?.id;
      }
      const slaDeadline = new Date(Date.now() + (SLA_HOURS[repairType] || 72) * 60 * 60 * 1000).toISOString();
      const { data: repairCase } = await supabase.from('repair_cases').insert([{ 
        wagon_id: wagonId, repair_type: repairType, current_status: '01 PLANNED', sla_deadline: slaDeadline,
        shop_progress: { telezhka: false, kolesa: false, malyarka: false, sborka: false }, signatures: { master: false, inspector: false, customer: false }
      }]).select().single();
      await supabase.from('status_events').insert([{ repair_id: repairCase.repair_id, new_status: '01 PLANNED', comment: `Регистрация (${user?.name})` }]);
      setWagonNumber(''); setView('dashboard'); loadData();
    } finally { setLoading(false); }
  }

  async function handleAddDocument() {
    if (!canEditOps || !docNumber.trim() || !selectedCase) return;
    vibrate('light');
    setLoading(true);
    await supabase.from('documents').insert([{ repair_id: selectedCase.repair_id, doc_type: docType, doc_number: docNumber, doc_date: new Date().toISOString().split('T')[0] }]);
    setDocNumber(''); openCaseDetails(selectedCase);
    setLoading(false);
  }

  async function handleConfirmDelay() {
    if (!canEditOps || !delayCause.trim()) return;
    vibrate('heavy');
    setLoading(true);
    await supabase.from('delay_log').insert([{ repair_id: selectedCase.repair_id, category: delayCategory, cause: delayCause, start_datetime: new Date().toISOString() }]);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: '08 REPAIR_PAUSED', comment: `Задержка: ${delayCause} [${user?.name}]` }]);
    await supabase.from('repair_cases').update({ current_status: '08 REPAIR_PAUSED', updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
    setShowDelayModal(false); setSelectedCase(null); setDelayCause(''); loadData();
    setLoading(false);
  }

  async function handleUnblockRepair() {
    if (!canEditOps || !selectedCase) return;
    vibrate('medium');
    setLoading(true);
    const now = new Date().toISOString();
    await supabase.from('delay_log').update({ end_datetime: now }).eq('repair_id', selectedCase.repair_id).is('end_datetime', null);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: '08 REPAIR_PAUSED', new_status: '07 IN_REPAIR', comment: `Задержка снята [${user?.name}]` }]);
    await supabase.from('repair_cases').update({ current_status: '07 IN_REPAIR', updated_at: now }).eq('repair_id', selectedCase.repair_id);
    setSelectedCase(null); loadData();
    setLoading(false);
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!canEditOps || !selectedCase) return;
    if (newStatus === '08 REPAIR_PAUSED') { setShowDelayModal(true); return; }
    vibrate('light');
    setLoading(true);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: newStatus, comment: `Смена статуса [${user?.name}]` }]);
    await supabase.from('repair_cases').update({ current_status: newStatus, updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
    setSelectedCase(null); loadData();
    setLoading(false);
  }

  function getSlaBadge(deadline: string) {
    if (!deadline) return null;
    const diffHours = (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60);
    if (diffHours < 0) return <span style={{ color: 'var(--danger)', fontWeight: 'bold', fontSize: '11px' }}>⚠️ Просрочен</span>;
    return <span style={{ color: 'var(--success)', fontSize: '11px', fontWeight: 'bold' }}>⏱ {Math.round(diffHours)} ч</span>;
  }

  const completedCases = repairs.filter((r: any) => r.current_status === '12 REPAIR_DONE' || r.current_status === '15 DEPARTED');
  const delayStats = DELAY_CATEGORIES.map(cat => ({ category: cat, count: delayLogs.filter((d: any) => d.category === cat).length }));
  const isFullySigned = signatures.master && signatures.inspector && signatures.customer;

  return (
    <div className="app-container">
      {/* Шапка */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '24px', fontWeight: '800' }}>🚆 ДЕПО</h2>
          <span style={{ fontSize: '14px', color: 'var(--tg-hint)' }}>{user?.name} • <b style={{color: 'var(--tg-btn)'}}>{user?.role}</b></span>
        </div>
      </header>

      {/* Вкладки */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', background: 'var(--tg-bg)', padding: '4px', borderRadius: '14px' }}>
        <button onClick={() => {vibrate('light'); setTab('ops')}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: tab === 'ops' ? 'var(--tg-btn)' : 'transparent', color: tab === 'ops' ? '#fff' : 'var(--tg-text)', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>📋 Операции</button>
        <button onClick={() => {vibrate('light'); setTab('analytics')}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: tab === 'analytics' ? 'var(--tg-btn)' : 'transparent', color: tab === 'analytics' ? '#fff' : 'var(--tg-text)', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>📊 Аналитика</button>
      </div>

      {tab === 'ops' ? (
        view === 'dashboard' ? (
          <>
            <div className="stats-grid">
              <div className="stat-box"><span className="stat-label">Всего вагонов</span><span className="stat-value">{stats.onSite}</span></div>
              <div className="stat-box highlight"><span className="stat-label" style={{color: '#1976d2'}}>В ремонте</span><span className="stat-value" style={{color: '#1976d2'}}>{stats.inRepair}</span></div>
              <div className="stat-box"><span className="stat-label">В очереди</span><span className="stat-value" style={{color: 'var(--warning)'}}>{stats.inQueue}</span></div>
              <div className="stat-box danger"><span className="stat-label" style={{color: '#d32f2f'}}>Задержано</span><span className="stat-value" style={{color: '#d32f2f'}}>{stats.blocked}</span></div>
            </div>

            {canEditOps && (
              <button className="btn-primary" onClick={() => {vibrate('light'); setView('add_wagon')}} style={{ marginBottom: '24px' }}>+ Зарегистрировать вагон</button>
            )}

            <h3 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: '700' }}>Реестр вагонов</h3>
            <div>
              {repairs.length === 0 ? <p style={{ color: 'var(--tg-hint)' }}>Пусто</p> : repairs.map((item: any) => {
                const doneShops = Object.values(item.shop_progress || {}).filter(Boolean).length;
                const isPaused = item.current_status === '08 REPAIR_PAUSED';
                return (
                  <div key={item.repair_id} className="card" onClick={() => openCaseDetails(item)} style={{ borderLeft: isPaused ? '4px solid var(--danger)' : '4px solid var(--tg-btn)', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '18px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
                      <span style={{ fontSize: '12px', fontWeight: '700', padding: '4px 8px', borderRadius: '8px', background: isPaused ? 'rgba(239, 68, 68, 0.1)' : 'var(--tg-sec-bg)', color: isPaused ? 'var(--danger)' : 'var(--tg-text)' }}>{item.current_status}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '13px', color: 'var(--tg-hint)' }}>
                      <span>{item.repair_type} ({item.wagons?.wagon_type})</span>
                      {getSlaBadge(item.sla_deadline)}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', fontSize: '12px', fontWeight: '600' }}>
                      <span style={{ color: doneShops === 4 ? 'var(--success)' : 'var(--tg-hint)' }}>🏭 Цехи: {doneShops}/4</span>
                      <span style={{ color: Object.values(item.signatures || {}).filter(Boolean).length === 3 ? 'var(--success)' : 'var(--warning)' }}>✍️ ВУ-36М: {Object.values(item.signatures || {}).filter(Boolean).length}/3</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="card">
            <h3 style={{ margin: '0 0 16px 0' }}>Новый вагон</h3>
            <label className="stat-label">Номер вагона</label>
            <input className="input-field" type="number" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="8 цифр" />
            
            <label className="stat-label" style={{marginTop: '12px', display:'block'}}>Тип вагона</label>
            <select className="select-field" value={wagonType} onChange={e => setWagonType(e.target.value)}><option>Полувагон</option><option>Цистерна</option><option>Крытый</option><option>Платформа</option></select>
            
            <label className="stat-label" style={{marginTop: '12px', display:'block'}}>Собственность</label>
            <select className="select-field" value={ownerType} onChange={e => setOwnerType(e.target.value)}><option value="Own">Собственный</option><option value="Third-party">Сторонний</option></select>
            
            <label className="stat-label" style={{marginTop: '12px', display:'block'}}>Вид ремонта</label>
            <select className="select-field" value={repairType} onChange={e => setRepairType(e.target.value)}><option>ТОР</option><option>ДР</option><option>КР</option><option>КРП</option><option>Модернизация</option></select>
            
            <div style={{ display: 'flex', gap: '8px', marginTop: '24px' }}>
              <button className="btn-secondary" onClick={() => setView('dashboard')}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading}>{loading ? '...' : 'Создать'}</button>
            </div>
          </div>
        )
      ) : (
        <div>
          <div className="stats-grid">
            <div className="stat-box highlight"><span className="stat-label">Выпуск (Мес)</span><span className="stat-value">{completedCases.length}</span></div>
            <div className="stat-box danger"><span className="stat-label">Инциденты</span><span className="stat-value">{delayLogs.length}</span></div>
          </div>
          
          <div className="card">
            <h4 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>Аналитика задержек</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {delayStats.map(stat => (
                <div key={stat.category}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight:'600', marginBottom: '4px' }}>
                    <span>{stat.category}</span><span>{stat.count}</span>
                  </div>
                  <div style={{ background: 'var(--tg-sec-bg)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: delayLogs.length > 0 ? `${(stat.count / delayLogs.length) * 100}%` : '0%', background: 'var(--danger)', height: '100%', borderRadius:'4px' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* НАТИВНОЕ МОДАЛЬНОЕ ОКНО (BOTTOM SHEET) */}
      {selectedCase && !showDelayModal && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="bottom-sheet">
            <div className="sheet-handle"></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: '800' }}>№ {selectedCase.wagons?.wagon_number}</h3>
                <span style={{ fontSize: '13px', color: 'var(--tg-hint)' }}>ID: {selectedCase.repair_id.split('-')[0]}...</span>
              </div>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'var(--tg-sec-bg)', border: 'none', borderRadius: '50%', width: '32px', height: '32px', fontWeight: 'bold', color: 'var(--tg-hint)', cursor: 'pointer' }}>✕</button>
            </div>

            {/* ЭТАП 1 */}
            <div className="card" style={{ background: 'var(--tg-sec-bg)', border: 'none' }}>
              <h4 style={{ margin: '0 0 12px 0', color: 'var(--tg-btn)' }}>1️⃣ Входной контроль</h4>
              
              {canEditOps && (
                <div style={{ display: 'flex', overflowX: 'auto', gap: '8px', paddingBottom: '8px', marginBottom: '8px', msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                  {STATUSES.map(st => {
                    const isBlocked = st === '12 REPAIR_DONE' && !isFullySigned;
                    const isCurrent = st === selectedCase.current_status;
                    return (
                      <button key={st} disabled={isCurrent || loading || isBlocked} onClick={() => handleUpdateStatus(st)} 
                        style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', whiteSpace: 'nowrap', fontWeight: '600', fontSize: '13px',
                          background: isCurrent ? 'var(--tg-text)' : 'var(--tg-bg)', color: isCurrent ? 'var(--tg-bg)' : 'var(--tg-text)', opacity: isBlocked ? 0.4 : 1, boxShadow: '0 2px 6px rgba(0,0,0,0.05)'
                        }}>
                        {st.split(' ')[1]}
                      </button>
                    );
                  })}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <select className="select-field" style={{ margin: 0, flex: 1 }} value={docType} onChange={e => setDocType(e.target.value)}>
                  <option>Справка 2612</option><option>Акт осмотра</option><option>ВУ-23М</option>
                </select>
                <input className="input-field" type="text" placeholder="№ док." value={docNumber} onChange={e => setDocNumber(e.target.value)} style={{ margin: 0, flex: 1 }}/>
                <button className="btn-primary" style={{ width: 'auto', padding: '0 16px' }} onClick={handleAddDocument}>+</button>
              </div>

              {documents.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                  {documents.map((d: any) => (
                    <span key={d.id} style={{ background: 'var(--tg-bg)', padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: '500', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                      📄 {d.doc_type} №{d.doc_number}
                    </span>
                  ))}
                </div>
              )}

              <label className="stat-label">Входные дефекты</label>
              <textarea className="textarea-field" disabled={!canEditOps} value={inputDefects} onChange={e => setInputDefects(e.target.value)} placeholder="Например: Излом пола..." rows={2} />
            </div>

            {/* ЭТАП 2 */}
            <div className="card" style={{ background: 'var(--tg-sec-bg)', border: 'none' }}>
              <h4 style={{ margin: '0 0 12px 0', color: 'var(--tg-btn)' }}>2️⃣ Прохождение цехов</h4>
              <div style={{ marginBottom: '16px' }}>
                {SHOPS.map(shop => {
                  const isDone = !!shopProgress[shop.id];
                  return (
                    <button key={shop.id} className={`list-btn ${isDone ? 'done' : ''}`} disabled={!canEditOps} onClick={() => handleToggleShop(shop.id)}>
                      <span>{shop.name}</span>
                      {isDone && <span style={{ fontWeight:'bold' }}>✓</span>}
                    </button>
                  );
                })}
              </div>
              <label className="stat-label">Учёт материалов (Цех 24)</label>
              <textarea className="textarea-field" disabled={!canEditOps} value={materialUsage} onChange={e => setMaterialUsage(e.target.value)} placeholder="1.25м х 0.90м = 10 шт..." rows={2} />
              {canEditOps && <button className="btn-primary" style={{ marginTop: '12px', padding: '10px' }} onClick={handleSaveTechData}>💾 Сохранить тексты</button>}
            </div>

            {/* ЭТАП 3 */}
            <div className="card" style={{ background: isFullySigned ? 'rgba(34, 197, 94, 0.1)' : 'var(--tg-sec-bg)', border: 'none' }}>
              <h4 style={{ margin: '0 0 12px 0', color: isFullySigned ? 'var(--success)' : 'var(--tg-btn)' }}>3️⃣ ВУ-36М (Финальная приёмка)</h4>
              <button className={`list-btn ${signatures.master ? 'done' : ''}`} disabled={!canSignMaster} onClick={() => handleToggleSignature('master')}>
                <span>👨‍🔧 Мастер цеха</span>{signatures.master ? '✓ Подписано' : 'Нажмите для подписи'}
              </button>
              <button className={`list-btn ${signatures.inspector ? 'done' : ''}`} disabled={!canSignInspector} onClick={() => handleToggleSignature('inspector')}>
                <span>🕵️‍♂️ Приёмщик ВК</span>{signatures.inspector ? '✓ Подписано' : 'Нажмите для подписи'}
              </button>
              <button className={`list-btn ${signatures.customer ? 'done' : ''}`} disabled={!canSignCustomer} onClick={() => handleToggleSignature('customer')}>
                <span>🏢 Заказчик</span>{signatures.customer ? '✓ Подписано' : 'Нажмите для подписи'}
              </button>
            </div>

            {selectedCase.current_status === '08 REPAIR_PAUSED' && (
              <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', border: 'none' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger)' }}>⛔ Заблокировано: {activeDelay?.category}</h4>
                <p style={{ margin: '0 0 12px 0', fontSize: '14px' }}>{activeDelay?.cause}</p>
                {canEditOps && <button className="btn-primary" style={{ background: 'var(--success)' }} onClick={handleUnblockRepair}>Снять задержку</button>}
              </div>
            )}
            
            <div style={{ height: '20px' }}></div>
          </div>
        </div>
      )}

      {/* Шторка задержки */}
      {showDelayModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 16px 0', color: 'var(--danger)' }}>⛔ Блокировка ремонта</h3>
            <label className="stat-label">Категория</label>
            <select className="select-field" value={delayCategory} onChange={e => setDelayCategory(e.target.value)}>
              {DELAY_CATEGORIES.map(cat => <option key={cat}>{cat}</option>)}
            </select>
            <label className="stat-label" style={{marginTop: '12px', display:'block'}}>Причина</label>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={3} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '24px' }}>
              <button className="btn-secondary" onClick={() => setShowDelayModal(false)}>Отмена</button>
              <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={handleConfirmDelay}>Заблокировать</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}