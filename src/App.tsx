import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import './App.css';

const STATUSES = [
  '01 PLANNED',
  '02 ARRIVED',
  '04 QUEUE',
  '07 IN_REPAIR',
  '08 REPAIR_PAUSED',
  '12 REPAIR_DONE',
  '15 DEPARTED'
];

const DELAY_CATEGORIES = ['Materials', 'Customer', 'Railway', 'Internal', 'Technical', 'External'];

const SLA_HOURS: Record<string, number> = {
  'ТОР': 24,
  'ДР': 72,
  'КР': 120,
  'КРП': 144,
  'Модернизация': 168
};

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
  
  const [activeDelay, setActiveDelay] = useState<any>(null);
  const [statusHistory, setStatusHistory] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  
  // Формы
  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [ownerType, setOwnerType] = useState('Own');
  const [repairType, setRepairType] = useState('ДР');
  const [loading, setLoading] = useState(false);

  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayCause, setDelayCause] = useState('');
  const [docType, setDocType] = useState('VU-23');
  const [docNumber, setDocNumber] = useState('');

  // Списки и статистика
  const [repairs, setRepairs] = useState<any[]>([]);
  const [delayLogs, setDelayLogs] = useState<any[]>([]);
  const [stats, setStats] = useState({ onSite: 0, inRepair: 0, inQueue: 0, blocked: 0 });

  useEffect(() => {
    initAuthAndData();
  }, []);

  async function initAuthAndData() {
    let tgUser: any = null;
    try {
      if (typeof window !== 'undefined' && WebApp && typeof WebApp.ready === 'function') {
        WebApp.ready();
        tgUser = WebApp.initDataUnsafe?.user;
      }
    } catch (e) {
      console.log('Запуск вне Telegram');
    }

    if (tgUser?.id) {
      const userName = `${tgUser.first_name} ${tgUser.last_name || ''}`.trim();

      const { data: dbUser, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', tgUser.id)
        .maybeSingle();

      if (fetchError) {
        alert("Ошибка поиска пользователя: " + fetchError.message);
      }

      if (dbUser) {
        setUser({ name: dbUser.name || userName, role: (dbUser.role as UserRole) || 'Dispatcher', telegram_id: tgUser.id });
      } else {
        const { data: newUser, error: insertError } = await supabase.from('users').insert([{ 
          telegram_id: tgUser.id, 
          name: userName, 
          role: 'Dispatcher' 
        }]).select().maybeSingle();

        if (insertError) {
          // ТЕПЕРЬ ОШИБКА ПОЯВИТСЯ НА ЭКРАНЕ В ТЕЛЕГРАМЕ
          alert("Ошибка БД при регистрации пользователя: " + insertError.message);
        }

        setUser({ name: userName, role: (newUser?.role as UserRole) || 'Dispatcher', telegram_id: tgUser.id });
      }
    } else {
      setUser({ name: 'Разработчик (Браузер)', role: 'Dispatcher' });
    }

    loadData();
  }
  
  async function loadData() {
    const { data, error } = await supabase
      .from('repair_cases')
      .select(`
        repair_id,
        current_status,
        repair_type,
        created_at,
        sla_deadline,
        updated_at,
        shop_progress,
        signatures,
        wagons ( wagon_number, wagon_type, owner_type )
      `)
      .order('created_at', { ascending: false });

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
    setSelectedCase(item);
    setShopProgress(item.shop_progress || { telezhka: false, kolesa: false, malyarka: false, sborka: false });
    setSignatures(item.signatures || { master: false, inspector: false, customer: false });
    
    if (item.current_status === '08 REPAIR_PAUSED') {
      const { data: delay } = await supabase.from('delay_log').select('*').eq('repair_id', item.repair_id).is('end_datetime', null).order('start_datetime', { ascending: false }).maybeSingle();
      setActiveDelay(delay);
    } else {
      setActiveDelay(null);
    }

    const { data: events } = await supabase.from('status_events').select('*').eq('repair_id', item.repair_id).order('recorded_datetime', { ascending: false });
    if (events) setStatusHistory(events);

    const { data: docs } = await supabase.from('documents').select('*').eq('repair_id', item.repair_id).order('created_at', { ascending: false });
    if (docs) setDocuments(docs);
  }

  // Права доступа
  const canEditOps = user?.role === 'Dispatcher' || user?.role === 'Master';
  const canSignMaster = user?.role === 'Dispatcher' || user?.role === 'Master';
  const canSignInspector = user?.role === 'Dispatcher' || user?.role === 'Inspector';
  const canSignCustomer = user?.role === 'Dispatcher' || user?.role === 'Customer';

  async function handleToggleShop(shopId: string) {
    if (!canEditOps || !selectedCase) return;

    const newProgress = { ...shopProgress, [shopId]: !shopProgress[shopId] };
    setShopProgress(newProgress);

    try {
      await supabase.from('repair_cases').update({ shop_progress: newProgress }).eq('repair_id', selectedCase.repair_id);
      const shopName = SHOPS.find(s => s.id === shopId)?.name;
      const action = newProgress[shopId] ? 'выполнен' : 'отменен';

      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: selectedCase.current_status,
        new_status: selectedCase.current_status,
        comment: `Цех: ${shopName} - этап ${action} [${user?.name}]`
      }]);

      loadData();
    } catch (err: any) {
      alert('Ошибка обновления этапа: ' + err.message);
    }
  }

  async function handleToggleSignature(sigKey: 'master' | 'inspector' | 'customer') {
    if (!selectedCase) return;

    if (sigKey === 'master' && !canSignMaster) { alert('Ошибка доступа: Подписать может только Мастер цеха!'); return; }
    if (sigKey === 'inspector' && !canSignInspector) { alert('Ошибка доступа: Подписать может только Приёмщик вагонов (ВК)!'); return; }
    if (sigKey === 'customer' && !canSignCustomer) { alert('Ошибка доступа: Подписать может только Представитель Заказчика!'); return; }

    const newSigs = { ...signatures, [sigKey]: !signatures[sigKey] };
    setSignatures(newSigs);

    try {
      await supabase.from('repair_cases').update({ signatures: newSigs }).eq('repair_id', selectedCase.repair_id);
      
      const sigNames: Record<string, string> = { master: 'Мастер цеха', inspector: 'Приёмщик ВК', customer: 'Представитель Заказчика' };
      const statusText = newSigs[sigKey] ? 'подписал' : 'отозвал подпись';

      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: selectedCase.current_status,
        new_status: selectedCase.current_status,
        comment: `Согласование ВУ-36М: ${sigNames[sigKey]} ${statusText} [${user?.name}]`
      }]);

      if (newSigs.master && newSigs.inspector && newSigs.customer) {
        const autoDocNum = `36M-${selectedCase.wagons?.wagon_number}`;
        await supabase.from('documents').insert([{
          repair_id: selectedCase.repair_id,
          doc_type: 'VU-36',
          doc_number: autoDocNum,
          doc_date: new Date().toISOString().split('T')[0]
        }]);
        alert(`Все 3 подписи получены! Акт ВУ-36М № ${autoDocNum} сформирован автоматически.`);
        openCaseDetails(selectedCase);
      }

      loadData();
    } catch (err: any) {
      alert('Ошибка подписи: ' + err.message);
    }
  }

  async function handleCreateRepair() {
    if (!canEditOps) return;
    if (!wagonNumber.trim()) { alert('Введите номер вагона'); return; }
    setLoading(true);

    try {
      let wagonId: string | null = null;
      const { data: existingWagon } = await supabase.from('wagons').select('id').eq('wagon_number', wagonNumber).maybeSingle();

      if (existingWagon) {
        wagonId = existingWagon.id;
      } else {
        const { data: newWagon, error: wagonError } = await supabase.from('wagons').insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner_type: ownerType }]).select().single();
        if (wagonError || !newWagon) throw wagonError;
        wagonId = newWagon.id;
      }

      const hours = SLA_HOURS[repairType] || 72;
      const slaDeadline = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

      const { data: repairCase, error: repairError } = await supabase.from('repair_cases').insert([{ 
        wagon_id: wagonId, 
        repair_type: repairType, 
        current_status: '01 PLANNED',
        sla_deadline: slaDeadline,
        shop_progress: { telezhka: false, kolesa: false, malyarka: false, sborka: false },
        signatures: { master: false, inspector: false, customer: false }
      }]).select().single();

      if (repairError || !repairCase) throw repairError;

      await supabase.from('status_events').insert([{
        repair_id: repairCase.repair_id,
        previous_status: null,
        new_status: '01 PLANNED',
        comment: `Регистрация (${user?.name || 'Пользователь'})`
      }]);

      alert('Успешно! Вагон зарегистрирован.');
      setWagonNumber('');
      setView('dashboard');
      loadData();
    } catch (err: any) {
      alert('Ошибка: ' + (err.message || 'Неизвестная ошибка'));
    } finally {
      setLoading(false);
    }
  }

  async function handleAddDocument() {
    if (!canEditOps) return;
    if (!docNumber.trim() || !selectedCase) { alert('Введите номер документа'); return; }
    setLoading(true);

    try {
      const { error } = await supabase.from('documents').insert([{
        repair_id: selectedCase.repair_id,
        doc_type: docType,
        doc_number: docNumber,
        doc_date: new Date().toISOString().split('T')[0]
      }]);

      if (error) throw error;
      alert(`Документ ${docType} №${docNumber} прикреплен!`);
      setDocNumber('');
      openCaseDetails(selectedCase);
    } catch (err: any) {
      alert('Ошибка при добавлении документа: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmDelay() {
    if (!canEditOps) return;
    if (!delayCause.trim()) { alert('Укажите причину остановки ремонта'); return; }
    setLoading(true);

    try {
      await supabase.from('delay_log').insert([{ repair_id: selectedCase.repair_id, category: delayCategory, cause: delayCause, start_datetime: new Date().toISOString() }]);

      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: selectedCase.current_status,
        new_status: '08 REPAIR_PAUSED',
        comment: `Задержка (${delayCategory}): ${delayCause} [${user?.name}]`
      }]);

      const { error } = await supabase.from('repair_cases').update({ current_status: '08 REPAIR_PAUSED', updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
      if (error) throw error;
      alert('Ремонт заблокирован!');
      setShowDelayModal(false);
      setSelectedCase(null);
      setDelayCause('');
      loadData();
    } catch (err: any) {
      alert('Ошибка: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnblockRepair() {
    if (!canEditOps) return;
    if (!selectedCase) return;
    setLoading(true);

    try {
      const now = new Date().toISOString();
      await supabase.from('delay_log').update({ end_datetime: now }).eq('repair_id', selectedCase.repair_id).is('end_datetime', null);

      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: '08 REPAIR_PAUSED',
        new_status: '07 IN_REPAIR',
        comment: `Задержка устранена. [Снял: ${user?.name}]`
      }]);

      const { error } = await supabase.from('repair_cases').update({ current_status: '07 IN_REPAIR', updated_at: now }).eq('repair_id', selectedCase.repair_id);
      if (error) throw error;
      alert('Задержка снята, вагон возвращен в ремонт!');
      setSelectedCase(null);
      loadData();
    } catch (err: any) {
      alert('Ошибка при разблокировке: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateStatus(newStatus: string) {
    if (!canEditOps) return;
    if (!selectedCase) return;

    if (newStatus === '08 REPAIR_PAUSED') {
      setShowDelayModal(true);
      return;
    }

    setLoading(true);
    try {
      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: selectedCase.current_status,
        new_status: newStatus,
        comment: `Смена статуса пользователем ${user?.name}`
      }]);

      const { error } = await supabase.from('repair_cases').update({ current_status: newStatus, updated_at: new Date().toISOString() }).eq('repair_id', selectedCase.repair_id);
      if (error) throw error;
      alert(`Статус изменен на: ${newStatus}`);
      setSelectedCase(null);
      loadData();
    } catch (err: any) {
      alert('Ошибка: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function getSlaBadge(deadline: string) {
    if (!deadline) return null;
    const diffHours = (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60);
    if (diffHours < 0) return <span style={{ color: '#d32f2f', fontWeight: 'bold', fontSize: '11px' }}>⚠️ Просрочен</span>;
    return <span style={{ color: '#2e7d32', fontSize: '11px' }}>⏱ {Math.round(diffHours)} ч</span>;
  }

  function getRoleBadge(role?: UserRole) {
    switch (role) {
      case 'Dispatcher': return <span style={{ background: '#e3f2fd', color: '#1976d2', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>Диспетчер</span>;
      case 'Master': return <span style={{ background: '#fff3e0', color: '#ed6c02', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>Мастер</span>;
      case 'Inspector': return <span style={{ background: '#f3e5f5', color: '#7b1fa2', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>Приёмщик ВК</span>;
      case 'Customer': return <span style={{ background: '#e8f5e9', color: '#2e7d32', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>Заказчик</span>;
      default: return null;
    }
  }

  const completedCases = repairs.filter((r: any) => r.current_status === '12 REPAIR_DONE' || r.current_status === '15 DEPARTED');
  const totalCases = repairs.length || 1;
  const onTimeCases = repairs.filter((r: any) => !r.sla_deadline || new Date(r.sla_deadline).getTime() >= Date.now()).length;
  const slaCompliance = Math.round((onTimeCases / totalCases) * 100);

  const delayStats = DELAY_CATEGORIES.map(cat => ({
    category: cat,
    count: delayLogs.filter((d: any) => d.category === cat).length
  }));

  const isFullySigned = signatures.master && signatures.inspector && signatures.customer;

  return (
    <div style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '480px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #ccc', paddingBottom: '12px', marginBottom: '12px' }}>
        <h2 style={{ margin: 0, fontSize: '20px' }}>🚆 ДЕПО СЕЙЧАС</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', marginBottom: '8px' }}>
          <span style={{ color: '#444', fontSize: '13px', fontWeight: 'bold' }}>👤 {user?.name || 'Загрузка...'}</span>
          {getRoleBadge(user?.role)}
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setTab('ops')} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: '6px', background: tab === 'ops' ? '#0088cc' : '#f0f0f0', color: tab === 'ops' ? '#fff' : '#333', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}>📋 Операции</button>
          <button onClick={() => setTab('analytics')} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: '6px', background: tab === 'analytics' ? '#0088cc' : '#f0f0f0', color: tab === 'analytics' ? '#fff' : '#333', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}>📊 Аналитика</button>
        </div>
      </header>

      {tab === 'ops' ? (
        view === 'dashboard' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
              <div style={{ background: '#f0f4f8', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: '#555' }}>Всего ремонтов</div>
                <div style={{ fontSize: '20px', fontWeight: 'bold' }}>{stats.onSite}</div>
              </div>
              <div style={{ background: '#e3f2fd', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: '#555' }}>В ремонте</div>
                <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#1976d2' }}>{stats.inRepair}</div>
              </div>
              <div style={{ background: '#fff3e0', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: '#555' }}>В очереди</div>
                <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#ed6c02' }}>{stats.inQueue}</div>
              </div>
              <div style={{ background: '#ffebee', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: '#555' }}>Заблокировано</div>
                <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#d32f2f' }}>{stats.blocked}</div>
              </div>
            </div>

            {canEditOps ? (
              <button onClick={() => setView('add_wagon')} style={{ width: '100%', padding: '12px', backgroundColor: '#0088cc', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '20px' }}>
                + Зарегистрировать вагон
              </button>
            ) : (
              <div style={{ padding: '8px', background: '#e8f5e9', color: '#2e7d32', borderRadius: '6px', fontSize: '12px', textAlign: 'center', marginBottom: '16px' }}>
                👁️ Режим роли «{user?.role}»
              </div>
            )}

            <h3 style={{ margin: '0 0 10px', fontSize: '16px' }}>Реестр вагонов на территории</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {repairs.length === 0 ? (
                <p style={{ color: '#888', fontSize: '14px' }}>Вагонов пока нет</p>
              ) : (
                repairs.map((item: any) => {
                  const progressObj = item.shop_progress || {};
                  const doneShops = Object.values(progressObj).filter(Boolean).length;
                  const sigObj = item.signatures || {};
                  const doneSigs = Object.values(sigObj).filter(Boolean).length;
                  
                  return (
                    <div 
                      key={item.repair_id}
                      onClick={() => openCaseDetails(item)}
                      style={{
                        background: item.current_status === '08 REPAIR_PAUSED' ? '#fff5f5' : '#fff',
                        border: item.current_status === '08 REPAIR_PAUSED' ? '1px solid #ffcdd2' : '1px solid #e0e0e0',
                        borderRadius: '8px', padding: '12px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 'bold', fontSize: '16px' }}>
                          № {item.wagons?.wagon_number || 'Неизвестен'}
                        </span>
                        <span style={{ 
                          fontSize: '11px', padding: '3px 8px', borderRadius: '12px', 
                          background: item.current_status === '08 REPAIR_PAUSED' ? '#ffebee' : item.current_status === '07 IN_REPAIR' ? '#e3f2fd' : '#f5f5f5',
                          color: item.current_status === '08 REPAIR_PAUSED' ? '#c62828' : item.current_status === '07 IN_REPAIR' ? '#1976d2' : '#333',
                          fontWeight: 'bold'
                        }}>
                          {item.current_status}
                        </span>
                      </div>
                      <div style={{ marginTop: '6px', fontSize: '12px', color: '#666', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Тип: <b>{item.repair_type}</b> ({item.wagons?.wagon_type})</span>
                        {getSlaBadge(item.sla_deadline)}
                      </div>

                      <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px dashed #eee', display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                        <span style={{ color: '#555' }}>Цехи: <b>{doneShops}/4</b></span>
                        <span style={{ color: doneSigs === 3 ? '#2e7d32' : '#ed6c02', fontWeight: 'bold' }}>
                          Подписи ВУ-36М: {doneSigs}/3
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <div style={{ background: '#f9f9f9', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ marginTop: 0 }}>Регистрация вагона</h3>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
              Номер вагона (8 цифр):
              <input type="text" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="52839102" style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }} />
            </label>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
              Род вагона:
              <select value={wagonType} onChange={e => setWagonType(e.target.value)} style={{ width: '100%', padding: '8px', marginTop: '4px' }}>
                <option value="Полувагон">Полувагон</option>
                <option value="Цистерна">Цистерна</option>
                <option value="Крытый">Крытый</option>
                <option value="Платформа">Платформа</option>
                <option value="Хоппер">Хоппер</option>
              </select>
            </label>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
              Собственность:
              <select value={ownerType} onChange={e => setOwnerType(e.target.value)} style={{ width: '100%', padding: '8px', marginTop: '4px' }}>
                <option value="Own">Собственный (Own)</option>
                <option value="Third-party">Сторонний (Client)</option>
              </select>
            </label>
            <label style={{ display: 'block', marginBottom: '16px', fontSize: '14px' }}>
              Вид ремонта:
              <select value={repairType} onChange={e => setRepairType(e.target.value)} style={{ width: '100%', padding: '8px', marginTop: '4px' }}>
                <option value="ТОР">ТОР (24 ч)</option>
                <option value="ДР">ДР (72 ч)</option>
                <option value="КР">КР (120 ч)</option>
                <option value="КРП">КРП (144 ч)</option>
                <option value="Модернизация">Модернизация (168 ч)</option>
              </select>
            </label>
            <button onClick={handleCreateRepair} disabled={loading} style={{ width: '100%', padding: '12px', backgroundColor: '#4caf50', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', marginBottom: '8px' }}>
              {loading ? 'Сохранение...' : 'Создать Repair Case'}
            </button>
            <button onClick={() => setView('dashboard')} style={{ width: '100%', padding: '10px', backgroundColor: '#ccc', border: 'none', borderRadius: '6px' }}>
              Отмена
            </button>
          </div>
        )
      ) : (
        <div>
          <h3 style={{ marginTop: 0, fontSize: '16px' }}>📊 Аналитический дашборд</h3>

          <div style={{ background: '#f5f5f5', borderRadius: '8px', padding: '16px', marginBottom: '16px', borderLeft: '4px solid #2e7d32' }}>
            <div style={{ fontSize: '12px', color: '#666' }}>Соблюдение SLA (В рамках нормативного срока)</div>
            <div style={{ fontSize: '28px', fontWeight: 'bold', color: slaCompliance >= 80 ? '#2e7d32' : '#d32f2f', margin: '4px 0' }}>
              {slaCompliance}%
            </div>
            <div style={{ background: '#e0e0e0', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ width: `${slaCompliance}%`, background: slaCompliance >= 80 ? '#4caf50' : '#f44336', height: '100%' }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
            <div style={{ background: '#e8f5e9', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: '#555' }}>Завершенные ремонты</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#2e7d32' }}>{completedCases.length}</div>
            </div>
            <div style={{ background: '#ffebee', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: '#555' }}>Всего событий задержек</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#c62828' }}>{delayLogs.length}</div>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 12px', fontSize: '14px' }}>Причины задержек (Delay Log)</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {delayStats.map(stat => (
                <div key={stat.category}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
                    <span><b>{stat.category}</b></span>
                    <span>{stat.count} случаев</span>
                  </div>
                  <div style={{ background: '#f0f0f0', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: delayLogs.length > 0 ? `${(stat.count / delayLogs.length) * 100}%` : '0%', background: '#d32f2f', height: '100%' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <h4 style={{ margin: '0 0 8px', fontSize: '14px' }}>Журнал последних задержек</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {delayLogs.length === 0 ? (
              <p style={{ color: '#888', fontSize: '13px' }}>Задержек не зафиксировано</p>
            ) : (
              delayLogs.slice(0, 5).map((d: any) => (
                <div key={d.id} style={{ background: '#f9f9f9', borderLeft: '3px solid #d32f2f', padding: '8px', borderRadius: '4px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Категория: <b>{d.category}</b></span>
                    <span style={{ color: '#888', fontSize: '10px' }}>{new Date(d.start_datetime).toLocaleDateString()}</span>
                  </div>
                  <div style={{ marginTop: '2px', color: '#444' }}>Причина: {d.cause}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Модальное окно деталей вагона */}
      {selectedCase && !showDelayModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 100
        }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '20px', width: '100%', maxWidth: '380px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 4px' }}>Вагон № {selectedCase.wagons?.wagon_number}</h3>
            <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
              Repair ID: {selectedCase.repair_id}
            </p>

            {/* ЧЕК-ЛИСТ ЦЕХОВ */}
            <div style={{ background: '#f0f4f8', borderRadius: '8px', padding: '12px', marginBottom: '12px', border: '1px solid #d0d7de' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '13px', color: '#1976d2' }}>🏭 Чек-лист прохождения цехов:</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {SHOPS.map(shop => {
                  const isDone = !!shopProgress[shop.id];
                  return (
                    <button
                      key={shop.id}
                      disabled={!canEditOps}
                      onClick={() => handleToggleShop(shop.id)}
                      style={{
                        padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        background: isDone ? '#e8f5e9' : '#fff',
                        border: isDone ? '1px solid #81c784' : '1px solid #ccc',
                        borderRadius: '6px', cursor: canEditOps ? 'pointer' : 'not-allowed',
                        opacity: canEditOps ? 1 : 0.7, fontSize: '12px', fontWeight: isDone ? 'bold' : 'normal'
                      }}
                    >
                      <span>{shop.name}</span>
                      <span>{isDone ? '✅ Готово' : '⏳ В ожидании'}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* БЛОК СОГЛАСОВАНИЯ ВУ-36М (С ЗАЩИТОЙ ПО РОЛЯМ) */}
            <div style={{ background: isFullySigned ? '#e8f5e9' : '#fff3e0', borderRadius: '8px', padding: '12px', marginBottom: '16px', border: isFullySigned ? '1px solid #81c784' : '1px solid #ffe0b2' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: '13px', color: isFullySigned ? '#2e7d32' : '#e65100' }}>
                ✍️ Согласование акта ВУ-36М (Приёмка):
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                  disabled={!canSignMaster}
                  onClick={() => handleToggleSignature('master')}
                  style={{
                    padding: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: signatures.master ? '#c8e6c9' : canSignMaster ? '#fff' : '#f5f5f5',
                    border: '1px solid #ccc', borderRadius: '6px', fontSize: '12px',
                    cursor: canSignMaster ? 'pointer' : 'not-allowed', opacity: canSignMaster ? 1 : 0.6
                  }}
                >
                  <span>👨‍🔧 1. Мастер цеха</span>
                  <span>{signatures.master ? '✅ Подписано' : canSignMaster ? '❌ Подписать' : '🔒 Нет прав'}</span>
                </button>

                <button
                  disabled={!canSignInspector}
                  onClick={() => handleToggleSignature('inspector')}
                  style={{
                    padding: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: signatures.inspector ? '#c8e6c9' : canSignInspector ? '#fff' : '#f5f5f5',
                    border: '1px solid #ccc', borderRadius: '6px', fontSize: '12px',
                    cursor: canSignInspector ? 'pointer' : 'not-allowed', opacity: canSignInspector ? 1 : 0.6
                  }}
                >
                  <span>🕵️‍♂️ 2. Приёмщик вагонов (ВК)</span>
                  <span>{signatures.inspector ? '✅ Подписано' : canSignInspector ? '❌ Подписать' : '🔒 Нет прав'}</span>
                </button>

                <button
                  disabled={!canSignCustomer}
                  onClick={() => handleToggleSignature('customer')}
                  style={{
                    padding: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: signatures.customer ? '#c8e6c9' : canSignCustomer ? '#fff' : '#f5f5f5',
                    border: '1px solid #ccc', borderRadius: '6px', fontSize: '12px',
                    cursor: canSignCustomer ? 'pointer' : 'not-allowed', opacity: canSignCustomer ? 1 : 0.6
                  }}
                >
                  <span>🏢 3. Представитель Заказчика</span>
                  <span>{signatures.customer ? '✅ Подписано' : canSignCustomer ? '❌ Подписать' : '🔒 Нет прав'}</span>
                </button>
              </div>
            </div>

            {selectedCase.current_status === '08 REPAIR_PAUSED' && (
              <div style={{ background: '#ffebee', border: '1px solid #ef5350', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
                <div style={{ fontWeight: 'bold', color: '#c62828', fontSize: '13px', marginBottom: '4px' }}>
                  ⛔ Задержка: {activeDelay?.category || 'Заблокирован'}
                </div>
                <div style={{ fontSize: '13px', color: '#333' }}>
                  Причина: <b>{activeDelay?.cause || 'Не указана'}</b>
                </div>
                {canEditOps && (
                  <button onClick={handleUnblockRepair} disabled={loading} style={{ marginTop: '10px', width: '100%', padding: '8px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}>
                    {loading ? 'Обработка...' : '✅ Снять задержку (В ремонт)'}
                  </button>
                )}
              </div>
            )}

            {canEditOps && (
              <>
                <p style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px' }}>Сменить статус ремонта:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
                  {STATUSES.map(st => {
                    const isDoneBtn = st === '12 REPAIR_DONE';
                    const isBlocked = isDoneBtn && !isFullySigned;

                    return (
                      <button
                        key={st}
                        disabled={st === selectedCase.current_status || loading || isBlocked}
                        onClick={() => handleUpdateStatus(st)}
                        style={{
                          padding: '8px 12px', textAlign: 'left',
                          background: st === '08 REPAIR_PAUSED' ? '#ffebee' : isBlocked ? '#f5f5f5' : st === selectedCase.current_status ? '#e0e0e0' : '#f5f5f5',
                          border: st === '08 REPAIR_PAUSED' ? '1px solid #ef5350' : '1px solid #ccc',
                          color: isBlocked ? '#aaa' : st === '08 REPAIR_PAUSED' ? '#c62828' : '#333',
                          borderRadius: '6px', cursor: isBlocked ? 'not-allowed' : 'pointer', fontSize: '13px',
                          fontWeight: st === '08 REPAIR_PAUSED' || isDoneBtn ? 'bold' : 'normal'
                        }}
                      >
                        {isDoneBtn && !isFullySigned ? '🔒 12 REPAIR_DONE (Нужно 3 подписи)' : st === '08 REPAIR_PAUSED' ? '⛔ 08 REPAIR_PAUSED (Заблокировать)' : st}
                      </button>
                    );
                  })}
                </div>

                <h4 style={{ margin: '16px 0 8px', fontSize: '14px' }}>Документы (ВУ-23, ВУ-36):</h4>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  <select value={docType} onChange={e => setDocType(e.target.value)} style={{ padding: '6px', fontSize: '12px' }}>
                    <option value="VU-23">ВУ-23М</option>
                    <option value="VU-22">ВУ-22</option>
                    <option value="VU-36">ВУ-36М</option>
                  </select>
                  <input type="text" placeholder="№ документа" value={docNumber} onChange={e => setDocNumber(e.target.value)} style={{ flex: 1, padding: '6px', fontSize: '12px' }} />
                  <button onClick={handleAddDocument} style={{ padding: '6px 12px', background: '#0088cc', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '12px' }}>
                    + Add
                  </button>
                </div>
              </>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px', marginTop: '8px' }}>
              {documents.map((d: any) => (
                <div key={d.id} style={{ background: '#e8f5e9', padding: '6px 10px', borderRadius: '4px', fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                  <span><b>{d.doc_type}</b> № {d.doc_number}</span>
                  <span style={{ color: '#666' }}>{d.doc_date}</span>
                </div>
              ))}
            </div>

            <h4 style={{ margin: '16px 0 8px', fontSize: '14px' }}>История изменений (Status Events):</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
              {statusHistory.map((ev: any) => (
                <div key={ev.event_id} style={{ background: '#f9f9f9', padding: '8px', borderRadius: '6px', borderLeft: '3px solid #0088cc', fontSize: '12px' }}>
                  <div>Статус: <b>{ev.new_status}</b></div>
                  <div style={{ color: '#666', fontSize: '11px' }}>{new Date(ev.recorded_datetime).toLocaleString()}</div>
                  {ev.comment && <div style={{ color: '#444', fontStyle: 'italic', marginTop: '2px' }}>{ev.comment}</div>}
                </div>
              ))}
            </div>

            <button onClick={() => setSelectedCase(null)} style={{ width: '100%', padding: '10px', background: '#333', color: '#fff', border: 'none', borderRadius: '6px' }}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Модальное окно задержки */}
      {showDelayModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 200 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '20px', width: '100%', maxWidth: '360px' }}>
            <h3 style={{ margin: '0 0 8px', color: '#c62828' }}>⛔ Фиксация задержки</h3>
            <p style={{ fontSize: '13px', color: '#666', margin: '0 0 12px' }}>Вагон № <b>{selectedCase?.wagons?.wagon_number}</b></p>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px' }}>
              Категория задержки:
              <select value={delayCategory} onChange={e => setDelayCategory(e.target.value)} style={{ width: '100%', padding: '8px', marginTop: '4px' }}>
                {DELAY_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'block', marginBottom: '16px', fontSize: '13px' }}>
              Причина остановки ремонта:
              <textarea value={delayCause} onChange={e => setDelayCause(e.target.value)} placeholder="Например: Ожидание поставки боковых рам" rows={3} style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }} />
            </label>
            <button onClick={handleConfirmDelay} disabled={loading} style={{ width: '100%', padding: '12px', backgroundColor: '#d32f2f', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', marginBottom: '8px', cursor: 'pointer' }}>
              {loading ? 'Сохранение...' : 'Заблокировать ремонт'}
            </button>
            <button onClick={() => setShowDelayModal(false)} style={{ width: '100%', padding: '8px', background: '#ccc', border: 'none', borderRadius: '6px' }}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}