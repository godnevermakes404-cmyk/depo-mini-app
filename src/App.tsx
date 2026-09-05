import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import './App.css';

declare global { interface Window { Telegram: any; } }

const STATUSES = ['01 PLANNED', '02 ARRIVED', '04 QUEUE', '07 IN_REPAIR', '08 REPAIR_PAUSED', '12 REPAIR_DONE', '15 DEPARTED'];
const DELAY_CATEGORIES = ['Materials', 'Customer', 'Railway', 'Internal', 'Technical', 'External'];
const DOCUMENT_TYPES = [
  'Справка 2612',
  'Справка 2602',
  'Акт осмотра',
  'ВУ-23М',
  'ВУ-22',
  'ВУ-36М',
  'Паспорт вагона'
];

const SLA_HOURS: Record<string, number> = { 'ТОР': 24, 'ДР': 72, 'КР': 120, 'КРП': 144, 'Модернизация': 168 };
const SHOPS = [
  { id: 'telezhka', name: '🛠️ Тележечный цех' },
  { id: 'kolesa', name: '⚙️ Колёсный цех' },
  { id: 'malyarka', name: '🎨 Малярный цех' },
  { id: 'sborka', name: '🔩 Сборка и испытания' }
];

type UserRole = 'Dispatcher' | 'Master' | 'Inspector' | 'Customer';
type AppTab = 'home' | 'wagons' | 'analytics' | 'profile';

export default function App() {
  const [user, setUser] = useState<{ name: string; role: UserRole; telegram_id?: number } | null>(null);
  
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [showAddModal, setShowAddModal] = useState(false);
  
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
  const [docType, setDocType] = useState(DOCUMENT_TYPES[0]);
  const [docNumber, setDocNumber] = useState('');

  const [repairs, setRepairs] = useState<any[]>([]);
  const [delayLogs, setDelayLogs] = useState<any[]>([]);
  const [stats, setStats] = useState({ onSite: 0, inRepair: 0, inQueue: 0, blocked: 0 });

  const vibrate = (style: 'light' | 'medium' | 'heavy' = 'light') => {
    try { if (window.Telegram?.WebApp?.HapticFeedback) window.Telegram.WebApp.HapticFeedback.impactOccurred(style); } catch (e) {}
  };

  useEffect(() => { initAuthAndData(); }, []);

  async function initAuthAndData() {
    let tgUser: any = null;
    let userName = 'Неизвестный пользователь';
    try {
      const tg = window.Telegram?.WebApp || WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        tg.setHeaderColor?.('bg_color');
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
      setUser({ name: 'Разработчик', role: 'Dispatcher' });
    }
    loadData();
  }

  async function loadData() {
    const { data } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, sla_deadline, updated_at, shop_progress, signatures, input_defects, material_usage,
        wagons ( wagon_number, wagon_type, owner_type )
      `).order('created_at', { ascending: false });

    if (data) {
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
    if (sigKey === 'master' && !canSignMaster) { alert('Только Мастер!'); return; }
    if (sigKey === 'inspector' && !canSignInspector) { alert('Только Приёмщик!'); return; }
    if (sigKey === 'customer' && !canSignCustomer) { alert('Только Заказчик!'); return; }

    vibrate('medium');
    const newSigs = { ...signatures, [sigKey]: !signatures[sigKey] };
    setSignatures(newSigs);
    await supabase.from('repair_cases').update({ signatures: newSigs }).eq('repair_id', selectedCase.repair_id);
    const sigNames: Record<string, string> = { master: 'Мастер цеха', inspector: 'Приёмщик ВК', customer: 'Представитель Заказчика' };
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: selectedCase.current_status, comment: `ВУ-36М: ${sigNames[sigKey]} ${newSigs[sigKey] ? 'подписал' : 'отозвал'} [${user?.name}]` }]);

    if (newSigs.master && newSigs.inspector && newSigs.customer) {
      const autoDocNum = `36M-${selectedCase.wagons?.wagon_number}`;
      await supabase.from('documents').insert([{ repair_id: selectedCase.repair_id, doc_type: 'ВУ-36М', doc_number: autoDocNum, doc_date: new Date().toISOString().split('T')[0] }]);
      vibrate('heavy'); alert(`ВУ-36М № ${autoDocNum} сформирован.`); openCaseDetails(selectedCase);
    }
    loadData();
  }

  async function handleCreateRepair() {
    if (!canEditOps || !wagonNumber.trim()) return;
    vibrate('light'); setLoading(true);
    try {
      let wagonId: string | null = null;
      const { data: existingWagon } = await supabase.from('wagons').select('id').eq('wagon_number', wagonNumber).maybeSingle();
      if (existingWagon) wagonId = existingWagon.id;
      else { const { data: w } = await supabase.from('wagons').insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner_type: ownerType }]).select().single(); wagonId = w?.id; }
      
      const slaDeadline = new Date(Date.now() + (SLA_HOURS[repairType] || 72) * 60 * 60 * 1000).toISOString();
      const { data: rCase } = await supabase.from('repair_cases').insert([{ wagon_id: wagonId, repair_type: repairType, current_status: '01 PLANNED', sla_deadline: slaDeadline, shop_progress: { telezhka: false, kolesa: false, malyarka: false, sborka: false }, signatures: { master: false, inspector: false, customer: false } }]).select().single();
      
      await supabase.from('status_events').insert([{ repair_id: rCase.repair_id, new_status: '01 PLANNED', comment: `Регистрация (${user?.name})` }]);
      setWagonNumber(''); setShowAddModal(false); loadData();
    } finally { setLoading(false); }
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!canEditOps || !selectedCase) return;
    if (newStatus === '08 REPAIR_PAUSED') { setShowDelayModal(true); return; }
    vibrate('light'); setLoading(true);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: newStatus, comment: `Смена статуса [${user?.name}]` }]);
    await supabase.from('repair_cases').update({ current_status: newStatus, updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
    setSelectedCase(null); loadData(); setLoading(false);
  }

  async function handleAddDocument() {
    if (!canEditOps || !docNumber.trim() || !selectedCase) return;
    setLoading(true);
    await supabase.from('documents').insert([{ repair_id: selectedCase.repair_id, doc_type: docType, doc_number: docNumber, doc_date: new Date().toISOString().split('T')[0] }]);
    setDocNumber(''); openCaseDetails(selectedCase); setLoading(false);
  }

  async function handleConfirmDelay() {
    if (!canEditOps || !delayCause.trim()) return;
    setLoading(true);
    await supabase.from('delay_log').insert([{ repair_id: selectedCase.repair_id, category: delayCategory, cause: delayCause, start_datetime: new Date().toISOString() }]);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: selectedCase.current_status, new_status: '08 REPAIR_PAUSED', comment: `Задержка: ${delayCause}` }]);
    await supabase.from('repair_cases').update({ current_status: '08 REPAIR_PAUSED', updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
    setShowDelayModal(false); setSelectedCase(null); setDelayCause(''); loadData(); setLoading(false);
  }

  async function handleUnblockRepair() {
    if (!canEditOps || !selectedCase) return;
    setLoading(true);
    const now = new Date().toISOString();
    await supabase.from('delay_log').update({ end_datetime: now }).eq('repair_id', selectedCase.repair_id).is('end_datetime', null);
    await supabase.from('status_events').insert([{ repair_id: selectedCase.repair_id, previous_status: '08 REPAIR_PAUSED', new_status: '07 IN_REPAIR', comment: `Задержка снята` }]);
    await supabase.from('repair_cases').update({ current_status: '07 IN_REPAIR', updated_at: now }).eq('repair_id', selectedCase.repair_id);
    setSelectedCase(null); loadData(); setLoading(false);
  }
  
  async function handleSaveTechData() {
    if (!canEditOps || !selectedCase) return;
    setLoading(true);
    await supabase.from('repair_cases').update({ input_defects: inputDefects, material_usage: materialUsage }).eq('repair_id', selectedCase.repair_id);
    vibrate('light'); setLoading(false); loadData();
  }

  const renderContent = () => {
    switch (currentTab) {
      case 'home':
        return (
          <>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '20px' }}>Сводка</h3>
            <div className="stats-grid">
              <div className="stat-box"><span className="stat-label">Вагонов</span><span className="stat-value">{stats.onSite}</span></div>
              <div className="stat-box"><span className="stat-label" style={{color: 'var(--brand-color)'}}>В ремонте</span><span className="stat-value" style={{color: 'var(--brand-color)'}}>{stats.inRepair}</span></div>
              <div className="stat-box"><span className="stat-label" style={{color: 'var(--warning)'}}>В очереди</span><span className="stat-value" style={{color: 'var(--warning)'}}>{stats.inQueue}</span></div>
              <div className="stat-box"><span className="stat-label" style={{color: 'var(--danger)'}}>Задержано</span><span className="stat-value" style={{color: 'var(--danger)'}}>{stats.blocked}</span></div>
            </div>
            
            <h3 style={{ margin: '24px 0 16px 0', fontSize: '20px' }}>Быстрые действия</h3>
            <div className="premium-card" onClick={() => {vibrate('light'); setCurrentTab('wagons');}} style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <div style={{ background: 'var(--brand-color)', color: '#fff', width: '40px', height: '40px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>🚆</div>
              <div>
                <h4 style={{ margin: 0, fontSize: '16px' }}>Управление вагонами</h4>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Реестр, статусы, цехи</span>
              </div>
            </div>
            <div className="premium-card" onClick={() => {vibrate('light'); setCurrentTab('analytics');}} style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <div style={{ background: 'var(--success)', color: '#fff', width: '40px', height: '40px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>📊</div>
              <div>
                <h4 style={{ margin: 0, fontSize: '16px' }}>Отчёты и аналитика</h4>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Выпуск за месяц, задержки</span>
              </div>
            </div>
          </>
        );

      case 'wagons':
        return (
          <>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '20px' }}>Реестр вагонов</h3>
            {repairs.length === 0 ? <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>Вагонов пока нет</p> : repairs.map((item: any) => {
              const isPaused = item.current_status === '08 REPAIR_PAUSED';
              return (
                <div key={item.repair_id} className="premium-card" onClick={() => openCaseDetails(item)} style={{ borderLeft: isPaused ? '4px solid var(--danger)' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '18px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
                    <span className="status-pill" style={{ color: isPaused ? 'var(--danger)' : 'var(--brand-color)' }}>{item.current_status.split(' ')[1]}</span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{item.repair_type} ({item.wagons?.wagon_type})</div>
                </div>
              );
            })}
            
            {canEditOps && (
              <button className="fab" onClick={() => {vibrate('medium'); setShowAddModal(true);}}>+</button>
            )}
          </>
        );

      case 'analytics':
        const currentMonth = new Date().getMonth();
        const monthlyReleases = repairs.filter((c: any) => (c.current_status === '12 REPAIR_DONE' || c.current_status === '15 DEPARTED') && new Date(c.updated_at).getMonth() === currentMonth);
        const delayStats = DELAY_CATEGORIES.map(cat => ({ category: cat, count: delayLogs.filter((d: any) => d.category === cat).length }));
        return (
          <>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '20px' }}>Аналитика</h3>
            <div className="premium-card">
              <h4 style={{ margin: '0 0 12px 0', fontSize: '15px' }}>Выпуск за текущий месяц: <b style={{color: 'var(--success)'}}>{monthlyReleases.length}</b></h4>
            </div>
            
            <h4 style={{ margin: '20px 0 12px 0', fontSize: '16px' }}>Причины задержек</h4>
            <div className="premium-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {delayStats.map(stat => (
                  <div key={stat.category}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight:'600', marginBottom: '6px' }}>
                      <span>{stat.category}</span><span>{stat.count}</span>
                    </div>
                    <div style={{ background: 'var(--bg-color)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ width: delayLogs.length > 0 ? `${(stat.count / delayLogs.length) * 100}%` : '0%', background: 'var(--danger)', height: '100%', borderRadius:'4px' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        );

      case 'profile':
        return (
          <>
            <div style={{ textAlign: 'center', margin: '30px 0' }}>
              <div style={{ width: '80px', height: '80px', background: 'var(--brand-color)', color: 'white', borderRadius: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px', margin: '0 auto 16px auto', fontWeight: 'bold' }}>
                {user?.name.charAt(0)}
              </div>
              <h2 style={{ margin: '0 0 4px 0' }}>{user?.name}</h2>
              <span className="status-pill" style={{ color: 'var(--brand-color)' }}>{user?.role}</span>
            </div>
            <div className="premium-card">
              <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                Вы авторизованы через Telegram.<br/>Ваш ID: {user?.telegram_id}
              </p>
            </div>
          </>
        );
    }
  };

  return (
    <div>
      <header className="brand-header">
        <h1 className="brand-title">ДЕПО</h1>
        <div style={{ width: '32px', height: '32px', background: 'var(--bg-color)', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>🔔</div>
      </header>

      <div className="content-area">
        {renderContent()}
      </div>

      <nav className="bottom-nav">
        <button className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} onClick={() => {vibrate('light'); setCurrentTab('home')}}>
          <div className="nav-icon">🏠</div><span>Главная</span>
        </button>
        <button className={`nav-item ${currentTab === 'wagons' ? 'active' : ''}`} onClick={() => {vibrate('light'); setCurrentTab('wagons')}}>
          <div className="nav-icon">🚆</div><span>Вагоны</span>
        </button>
        <button className={`nav-item ${currentTab === 'analytics' ? 'active' : ''}`} onClick={() => {vibrate('light'); setCurrentTab('analytics')}}>
          <div className="nav-icon">📊</div><span>Аналитика</span>
        </button>
        <button className={`nav-item ${currentTab === 'profile' ? 'active' : ''}`} onClick={() => {vibrate('light'); setCurrentTab('profile')}}>
          <div className="nav-icon">👤</div><span>Профиль</span>
        </button>
      </nav>

      {/* Модалка: Добавить вагон */}
      {showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 16px 0' }}>Регистрация вагона</h3>
            <input className="input-field" type="number" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="Номер вагона (8 цифр)" />
            <select className="select-field" value={wagonType} onChange={e => setWagonType(e.target.value)}><option>Полувагон</option><option>Цистерна</option><option>Крытый</option></select>
            <select className="select-field" value={ownerType} onChange={e => setOwnerType(e.target.value)}><option value="Own">Собственный</option><option value="Third-party">Сторонний</option></select>
            <select className="select-field" value={repairType} onChange={e => setRepairType(e.target.value)}><option>ТОР</option><option>ДР</option><option>КР</option></select>
            <div style={{ display: 'flex', gap: '8px', marginTop: '24px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка: Карточка вагона */}
      {selectedCase && !showDelayModal && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="bottom-sheet">
            <div className="sheet-handle"></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: '800' }}>№ {selectedCase.wagons?.wagon_number}</h3>
                <span className="status-pill" style={{ color: 'var(--brand-color)' }}>{selectedCase.current_status}</span>
              </div>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'var(--bg-color)', border: 'none', borderRadius: '16px', width: '32px', height: '32px', fontWeight: 'bold', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
            </div>

            {/* ЭТАП 1 */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 12px 0', color: 'var(--brand-color)' }}>1️⃣ Входной контроль</h4>
              {canEditOps && (
                <div style={{ display: 'flex', overflowX: 'auto', gap: '8px', paddingBottom: '8px', marginBottom: '8px' }}>
                  {STATUSES.map(st => (
                    <button key={st} disabled={st === selectedCase.current_status || loading} onClick={() => handleUpdateStatus(st)} 
                      style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', fontWeight: '600', fontSize: '13px', background: st === selectedCase.current_status ? 'var(--text-main)' : 'var(--bg-color)', color: st === selectedCase.current_status ? 'var(--card-bg)' : 'var(--text-main)' }}>
                      {st.split(' ')[1]}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <select className="select-field" style={{ margin: 0, flex: 1 }} value={docType} onChange={e => setDocType(e.target.value)}>
                  {DOCUMENT_TYPES.map(doc => (
                    <option key={doc} value={doc}>{doc}</option>
                  ))}
                </select>
                <input className="input-field" type="text" placeholder="№ док." value={docNumber} onChange={e => setDocNumber(e.target.value)} style={{ margin: 0, flex: 1 }}/>
                <button className="btn-primary" style={{ width: 'auto', padding: '0 16px' }} onClick={handleAddDocument}>+</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                {documents.map((d: any) => (<span key={d.id} style={{ background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '8px', fontSize: '12px' }}>📄 {d.doc_type} №{d.doc_number}</span>))}
              </div>
              <textarea className="textarea-field" disabled={!canEditOps} value={inputDefects} onChange={e => setInputDefects(e.target.value)} placeholder="Входные дефекты..." rows={2} style={{ marginTop: '12px' }} />
            </div>

            {/* ЭТАП 2 */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 12px 0', color: 'var(--brand-color)' }}>2️⃣ Цехи и Материалы</h4>
              {SHOPS.map(shop => {
                const isDone = !!shopProgress[shop.id];
                return (
                  <button key={shop.id} className={`list-btn ${isDone ? 'done' : ''}`} disabled={!canEditOps} onClick={() => handleToggleShop(shop.id)}>
                    <span>{shop.name}</span>{isDone && <span>✓</span>}
                  </button>
                );
              })}
              <textarea className="textarea-field" disabled={!canEditOps} value={materialUsage} onChange={e => setMaterialUsage(e.target.value)} placeholder="Расход металла..." rows={2} />
              {canEditOps && <button className="btn-primary" style={{ marginTop: '12px', padding: '10px' }} onClick={handleSaveTechData}>Сохранить текст</button>}
            </div>

            {/* ЭТАП 3 */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 12px 0', color: 'var(--brand-color)' }}>3️⃣ ВУ-36М</h4>
              <button className={`list-btn ${signatures.master ? 'done' : ''}`} disabled={!canSignMaster} onClick={() => handleToggleSignature('master')}><span>👨‍🔧 Мастер</span>{signatures.master ? '✓' : 'Подписать'}</button>
              <button className={`list-btn ${signatures.inspector ? 'done' : ''}`} disabled={!canSignInspector} onClick={() => handleToggleSignature('inspector')}><span>🕵️‍♂️ Приёмщик</span>{signatures.inspector ? '✓' : 'Подписать'}</button>
              <button className={`list-btn ${signatures.customer ? 'done' : ''}`} disabled={!canSignCustomer} onClick={() => handleToggleSignature('customer')}><span>🏢 Заказчик</span>{signatures.customer ? '✓' : 'Подписать'}</button>
            </div>

            {/* ИСТОРИЯ ИЗМЕНЕНИЙ */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--text-muted)' }}>📜 Журнал событий</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {statusHistory.map((ev: any) => (
                  <div key={ev.event_id || ev.recorded_datetime} style={{ background: 'var(--bg-color)', padding: '8px 12px', borderRadius: '8px', fontSize: '12px' }}>
                    <div style={{ fontWeight: 'bold' }}>{ev.new_status}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{new Date(ev.recorded_datetime).toLocaleString()}</div>
                    {ev.comment && <div style={{ marginTop: '2px', fontStyle: 'italic' }}>{ev.comment}</div>}
                  </div>
                ))}
              </div>
            </div>

            {selectedCase.current_status === '08 REPAIR_PAUSED' && (
              <div className="premium-card" style={{ border: '1px solid var(--danger)' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger)' }}>⛔ Заблокировано</h4>
                <p style={{ margin: '0 0 12px 0', fontSize: '14px' }}>{activeDelay?.cause}</p>
                {canEditOps && <button className="btn-primary" style={{ background: 'var(--success)' }} onClick={handleUnblockRepair}>Снять задержку</button>}
              </div>
            )}
            <div style={{ height: '40px' }}></div>
          </div>
        </div>
      )}
      
      {/* Модалка: Блокировка */}
      {showDelayModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 16px 0', color: 'var(--danger)' }}>⛔ Блокировка ремонта</h3>
            <select className="select-field" value={delayCategory} onChange={e => setDelayCategory(e.target.value)}>{DELAY_CATEGORIES.map(cat => <option key={cat}>{cat}</option>)}</select>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={3} placeholder="Причина задержки" style={{ marginTop: '12px' }} />
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