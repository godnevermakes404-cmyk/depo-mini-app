import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import { 
  STATUS_RU, ALLOWED_TRANSITIONS, ON_SITE_STATUSES,
  runDataQualityChecks, calculateLostWagonDays, DQViolation 
} from './depoEngine';
import './App.css';

declare global { interface Window { Telegram: any; } }

type AppTab = 'home' | 'wagons' | 'analytics' | 'profile';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [currentTab, setCurrentTab] = useState<AppTab>('home');
  const [showAddModal, setShowAddModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const [repairs, setRepairs] = useState<any[]>([]);
  const [delayLogs, setDelayLogs] = useState<any[]>([]);
  const [dqViolations, setDqViolations] = useState<DQViolation[]>([]);
  
  const [selectedCase, setSelectedCase] = useState<any>(null);
  const [statusHistory, setStatusHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayType, setDelayType] = useState<'PRIMARY' | 'SECONDARY'>('PRIMARY');
  const [delayCause, setDelayCause] = useState('');
  const [responsibleParty, setResponsibleParty] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [actionDeadline, setActionDeadline] = useState('');

  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [repairType, setRepairType] = useState('ДР');
  const [owner, setOwner] = useState('ПРОМТРАНС');
  const [ownerType, setOwnerType] = useState('Own');

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
      } else {
        const { data: newUser } = await supabase.from('users').insert([{ telegram_id: tgUser.id, name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(), role: 'PENDING' }]).select().single();
        setUser(newUser);
      }
    } else {
      setUser({ id: '00000000-0000-0000-0000-000000000000', name: 'Разработчик', role: 'ADMIN' });
    }
    loadData();
  }

  async function loadData() {
    const { data: repairData } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, sla_deadline, planned_release, forecast_release,
        input_defects, material_usage, shop_progress, signatures,
        wagons ( wagon_number, wagon_type, owner, owner_type )
      `).order('created_at', { ascending: false });

    const { data: delays } = await supabase.from('delay_log').select('*').order('start_datetime', { ascending: false });

    if (repairData && delays) {
      setRepairs(repairData);
      setDelayLogs(delays);
      setDqViolations(runDataQualityChecks(repairData, delays));
    }
  }

  async function openCaseDetails(item: any) {
    vibrate('light');
    setSelectedCase(item);
    const { data: events } = await supabase.from('status_events').select('*').eq('repair_id', item.repair_id).order('event_datetime', { ascending: false });
    if (events) setStatusHistory(events);
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!selectedCase) return;
    if (newStatus === '08 REPAIR_PAUSED') {
      setShowDelayModal(true);
      return;
    }

    vibrate('medium');
    setLoading(true);
    const { error } = await supabase.rpc('change_repair_status', {
      p_repair_id: selectedCase.repair_id,
      p_new_status: newStatus,
      p_user_id: user?.id,
      p_comment: `Переход на ${STATUS_RU[newStatus] || newStatus}`
    });

    if (error) {
      alert('Ошибка перевода статуса: ' + error.message);
    } else {
      setSelectedCase(null);
      loadData();
    }
    setLoading(false);
  }

  async function handleConfirmDelay() {
    if (!delayCause.trim() || !nextAction.trim() || !responsibleParty.trim()) {
      alert('Заполните причину, ответственного и следующее действие (Next Action)!');
      return;
    }

    setLoading(true);
    vibrate('heavy');

    await supabase.from('delay_log').insert([{
      repair_id: selectedCase.repair_id,
      category: delayCategory,
      delay_type: delayType,
      cause: delayCause,
      responsible_party: responsibleParty,
      next_action: nextAction,
      action_deadline: actionDeadline ? new Date(actionDeadline).toISOString() : null,
      start_datetime: new Date().toISOString()
    }]);

    await supabase.rpc('change_repair_status', {
      p_repair_id: selectedCase.repair_id,
      p_new_status: '08 REPAIR_PAUSED',
      p_user_id: user?.id,
      p_comment: `Задержка [${delayCategory}]: ${delayCause}`
    });

    setShowDelayModal(false);
    setSelectedCase(null);
    setDelayCause(''); setNextAction(''); setResponsibleParty('');
    loadData();
    setLoading(false);
  }

  async function handleCreateRepair() {
    if (!wagonNumber.trim() || wagonNumber.length !== 8) {
      alert('Введите корректный 8-значный номер вагона!');
      return;
    }

    setLoading(true);
    try {
      let wagonId: string | null = null;
      const { data: existingWagon } = await supabase.from('wagons').select('id').eq('wagon_number', wagonNumber).maybeSingle();
      if (existingWagon) {
        wagonId = existingWagon.id;
      } else {
        const { data: w } = await supabase.from('wagons').insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner, owner_type: ownerType }]).select().single();
        wagonId = w?.id;
      }

      const { data: rCase, error } = await supabase.from('repair_cases').insert([{
        wagon_id: wagonId,
        repair_type: repairType,
        current_status: '01 PLANNED',
        sla_deadline: new Date(Date.now() + 72 * 3600 * 1000).toISOString()
      }]).select().single();

      if (error) throw error;

      await supabase.rpc('change_repair_status', {
        p_repair_id: rCase.repair_id,
        p_new_status: '01 PLANNED',
        p_user_id: user?.id,
        p_comment: 'Регистрация вагона в системе'
      });

      setWagonNumber(''); setShowAddModal(false); loadData();
    } catch (err: any) {
      alert('Ошибка создания: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function exportToCSV() {
    const headers = ['Wagon Number', 'Status', 'Repair Type', 'Owner', 'Owner Type', 'SLA Deadline'];
    const rows = filteredRepairs.map(r => [
      r.wagons?.wagon_number,
      STATUS_RU[r.current_status] || r.current_status,
      r.repair_type,
      r.wagons?.owner,
      r.wagons?.owner_type,
      r.sla_deadline ? new Date(r.sla_deadline).toLocaleString() : ''
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `depo_wagons_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const onSiteRepairs = repairs.filter(r => ON_SITE_STATUSES.includes(r.current_status));
  const filteredRepairs = statusFilter ? repairs.filter(r => r.current_status === statusFilter) : repairs;
  const lostWagonDays = calculateLostWagonDays(delayLogs);
  const availableTransitions = selectedCase ? (ALLOWED_TRANSITIONS[selectedCase.current_status] || []) : [];

  return (
    <div>
      <header className="brand-header">
        <h1 className="brand-title">ДЕПО TMS</h1>
        <span className="status-pill">{user?.role || 'PENDING'}</span>
      </header>

      <div className="content-area">
        {currentTab === 'home' && (
          <>
            {dqViolations.length > 0 && (
              <div className="premium-card" style={{ borderLeft: '4px solid var(--danger)', background: 'rgba(255, 59, 48, 0.05)' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger)', fontSize: '13px' }}>🚨 Требуют внимания ({dqViolations.length})</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {dqViolations.map((v, i) => (
                    <div key={i} style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between' }}>
                      <span><b>Вагон №{v.wagon_number}</b>: {v.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <h3 style={{ margin: '12px 0', fontSize: '16px' }}>На территории: {onSiteRepairs.length}</h3>
            <div className="stats-grid">
              <div className="stat-box" onClick={() => { setStatusFilter('04 QUEUE'); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--warning)' }}>В очереди</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === '04 QUEUE').length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter('07 IN_REPAIR'); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--brand-color)' }}>В ремонте</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === '07 IN_REPAIR').length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter('08 REPAIR_PAUSED'); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--danger)' }}>Задержано</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === '08 REPAIR_PAUSED').length}</span>
              </div>
              <div className="stat-box" onClick={() => { setStatusFilter('11 READY_TO_DISPATCH'); setCurrentTab('wagons'); }}>
                <span className="stat-label" style={{ color: 'var(--success)' }}>Готовы</span>
                <span className="stat-value">{repairs.filter(r => r.current_status === '11 READY_TO_DISPATCH').length}</span>
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
              <h3 style={{ margin: 0, fontSize: '16px' }}>
                {statusFilter ? `Фильтр: ${STATUS_RU[statusFilter]}` : 'Все вагоны'}
              </h3>
              <div style={{ display: 'flex', gap: '6px' }}>
                {statusFilter && <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={() => setStatusFilter(null)}>Сброс</button>}
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }} onClick={exportToCSV}>💾 Excel</button>
              </div>
            </div>

            {filteredRepairs.map((item: any) => (
              <div key={item.repair_id} className="premium-card" onClick={() => openCaseDetails(item)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '15px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
                  <span className="status-pill">{STATUS_RU[item.current_status] || item.current_status}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{item.repair_type} • {item.wagons?.owner}</span>
                  <span>{item.wagons?.owner_type}</span>
                </div>
              </div>
            ))}

            <button className="fab" onClick={() => setShowAddModal(true)}>+</button>
          </>
        )}

        {currentTab === 'analytics' && (
          <div className="premium-card">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>Аналитика потерь (Pareto)</h3>
            {(Object.entries(lostWagonDays.byCategory) as [string, number][]).map(([cat, days]) => (
              <div key={cat} style={{ marginBottom: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
                  <span><b>{cat}</b></span>
                  <span>{days.toFixed(1)} вагон-дней</span>
                </div>
                <div style={{ background: 'var(--bg-color)', height: '6px', borderRadius: '3px' }}>
                  <div style={{ width: `${Math.min(100, (days / (lostWagonDays.totalDays || 1)) * 100)}%`, background: 'var(--danger)', height: '100%', borderRadius: '3px' }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {currentTab === 'profile' && (
          <div className="premium-card" style={{ textAlign: 'center' }}>
            <h3 style={{ margin: '0 0 4px 0' }}>{user?.name}</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Роль: {user?.role}</p>
          </div>
        )}
      </div>

      <nav className="bottom-nav">
        <button className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} onClick={() => setCurrentTab('home')}>
          <div className="nav-icon">🏠</div><span>Главная</span>
        </button>
        <button className={`nav-item ${currentTab === 'wagons' ? 'active' : ''}`} onClick={() => setCurrentTab('wagons')}>
          <div className="nav-icon">🚆</div><span>Вагоны</span>
        </button>
        <button className={`nav-item ${currentTab === 'analytics' ? 'active' : ''}`} onClick={() => setCurrentTab('analytics')}>
          <div className="nav-icon">📊</div><span>Аналитика</span>
        </button>
        <button className={`nav-item ${currentTab === 'profile' ? 'active' : ''}`} onClick={() => setCurrentTab('profile')}>
          <div className="nav-icon">👤</div><span>Профиль</span>
        </button>
      </nav>

      {showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '15px' }}>Регистрация вагона</h3>
            <input className="input-field" type="number" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="Номер вагона (8 цифр)" />
            <select className="select-field" value={wagonType} onChange={e => setWagonType(e.target.value)}><option>Полувагон</option><option>Цистерна</option><option>Платформа</option></select>
            <select className="select-field" value={repairType} onChange={e => setRepairType(e.target.value)}><option>ТОР</option><option>ДР</option><option>КР</option><option>КРП</option></select>
            <input className="input-field" type="text" value={owner} onChange={e => setOwner(e.target.value)} placeholder="Собственник" />
            <select className="select-field" value={ownerType} onChange={e => setOwnerType(e.target.value)}><option value="Own">Собственный</option><option value="Third-party">Сторонний</option></select>
            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {selectedCase && !showDelayModal && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="bottom-sheet">
            <div className="sheet-handle"></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px' }}>№ {selectedCase.wagons?.wagon_number}</h3>
                <span className="status-pill" style={{ color: 'var(--brand-color)' }}>
                  Текущий: {STATUS_RU[selectedCase.current_status] || selectedCase.current_status}
                </span>
              </div>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'transparent', border: 'none', fontSize: '16px' }}>✕</button>
            </div>

            <div className="premium-card">
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px' }}>Допустимые действия (State Machine):</h4>
              {availableTransitions.length === 0 ? (
                <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Цепочка завершена</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {availableTransitions.map((st: string) => (
                    <button key={st} disabled={loading} onClick={() => handleUpdateStatus(st)} className="btn-primary" style={{ padding: '6px 10px', fontSize: '11px', width: 'auto' }}>
                      → {STATUS_RU[st] || st}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="premium-card">
              <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', color: 'var(--text-muted)' }}>📜 Журнал событий</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {statusHistory.map((ev: any) => (
                  <div key={ev.event_id} style={{ fontSize: '10px', padding: '4px', background: 'var(--bg-color)', borderRadius: '4px' }}>
                    <b>{STATUS_RU[ev.new_status] || ev.new_status}</b> • {new Date(ev.event_datetime).toLocaleString()}
                    {ev.comment && <div style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>{ev.comment}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showDelayModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', color: 'var(--danger)', fontSize: '15px' }}>⛔ Регистрация задержки (Blocker)</h3>
            <select className="select-field" value={delayType} onChange={e => setDelayType(e.target.value as any)}>
              <option value="PRIMARY">PRIMARY (Первичная)</option>
              <option value="SECONDARY">SECONDARY (Вторичная)</option>
            </select>
            <select className="select-field" value={delayCategory} onChange={e => setDelayCategory(e.target.value)}>
              <option value="Materials">Материалы / Запчасти</option>
              <option value="Customer">Заказчик / Согласование</option>
              <option value="Railway">ЖД / Маневры</option>
              <option value="Internal">Внутренняя / Кадры</option>
            </select>
            <textarea className="textarea-field" value={delayCause} onChange={e => setDelayCause(e.target.value)} rows={2} placeholder="Причина задержки" />
            <input className="input-field" type="text" value={responsibleParty} onChange={e => setResponsibleParty(e.target.value)} placeholder="Ответственный (ФИО)" />
            <input className="input-field" type="text" value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder="Next Action (Следующее действие)" />
            <input className="input-field" type="datetime-local" value={actionDeadline} onChange={e => setActionDeadline(e.target.value)} />
            
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