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

const DELAY_CATEGORIES = [
  'Materials',
  'Customer',
  'Railway',
  'Internal',
  'Technical',
  'External'
];

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<'dashboard' | 'add_wagon'>('dashboard');
  const [selectedCase, setSelectedCase] = useState<any>(null);
  
  // Поля регистрации
  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [ownerType, setOwnerType] = useState('Own');
  const [repairType, setRepairType] = useState('ДР');
  const [loading, setLoading] = useState(false);

  // Поля задержки
  const [showDelayModal, setShowDelayModal] = useState(false);
  const [delayCategory, setDelayCategory] = useState('Materials');
  const [delayCause, setDelayCause] = useState('');

  // Список ремонтов и статистика
  const [repairs, setRepairs] = useState<any[]>([]);
  const [stats, setStats] = useState({
    onSite: 0,
    inRepair: 0,
    inQueue: 0,
    blocked: 0
  });

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && WebApp && typeof WebApp.ready === 'function') {
        WebApp.ready();
        if (WebApp.initDataUnsafe?.user) {
          setUser(WebApp.initDataUnsafe.user);
        }
      }
    } catch (e) {
      console.log('Запуск в браузере');
    }
    loadData();
  }, []);

  async function loadData() {
    const { data, error } = await supabase
      .from('repair_cases')
      .select(`
        repair_id,
        current_status,
        repair_type,
        created_at,
        wagons (
          wagon_number,
          wagon_type,
          owner_type
        )
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
  }

  async function handleCreateRepair() {
    if (!wagonNumber.trim()) {
      alert('Введите номер вагона');
      return;
    }
    setLoading(true);

    try {
      let wagonId: string | null = null;

      const { data: existingWagon } = await supabase
        .from('wagons')
        .select('id')
        .eq('wagon_number', wagonNumber)
        .maybeSingle();

      if (existingWagon) {
        wagonId = existingWagon.id;
      } else {
        const { data: newWagon, error: wagonError } = await supabase
          .from('wagons')
          .insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner_type: ownerType }])
          .select()
          .single();

        if (wagonError || !newWagon) throw wagonError;
        wagonId = newWagon.id;
      }

      const { data: repairCase, error: repairError } = await supabase
        .from('repair_cases')
        .insert([{
          wagon_id: wagonId,
          repair_type: repairType,
          current_status: '01 PLANNED'
        }])
        .select()
        .single();

      if (repairError || !repairCase) throw repairError;

      await supabase.from('status_events').insert([{
        repair_id: repairCase.repair_id,
        previous_status: null,
        new_status: '01 PLANNED',
        comment: 'Первоначальная регистрация ремонта'
      }]);

      alert('Успешно! Вагон зарегистрирован.');
      setWagonNumber('');
      setView('dashboard');
      loadData();
    } catch (err: any) {
      alert('Ошибка при сохранении: ' + (err.message || 'Неизвестная ошибка'));
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateStatus(newStatus: string) {
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
        comment: 'Смена статуса из Telegram Mini App'
      }]);

      const { error } = await supabase
        .from('repair_cases')
        .update({ current_status: newStatus, updated_at: new Date().toISOString() })
        .eq('repair_id', selectedCase.repair_id);

      if (error) throw error;

      alert(`Статус изменен на: ${newStatus}`);
      setSelectedCase(null);
      loadData();
    } catch (err: any) {
      alert('Ошибка при смене статуса: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmDelay() {
    if (!delayCause.trim()) {
      alert('Укажите причину остановки ремонта');
      return;
    }
    setLoading(true);

    try {
      await supabase.from('delay_log').insert([{
        repair_id: selectedCase.repair_id,
        category: delayCategory,
        cause: delayCause,
        start_datetime: new Date().toISOString()
      }]);

      await supabase.from('status_events').insert([{
        repair_id: selectedCase.repair_id,
        previous_status: selectedCase.current_status,
        new_status: '08 REPAIR_PAUSED',
        comment: `Задержка (${delayCategory}): ${delayCause}`
      }]);

      const { error } = await supabase
        .from('repair_cases')
        .update({ current_status: '08 REPAIR_PAUSED', updated_at: new Date().toISOString() })
        .eq('repair_id', selectedCase.repair_id);

      if (error) throw error;

      alert('Ремонт заблокирован, причина зафиксирована в Delay Log!');
      setShowDelayModal(false);
      setSelectedCase(null);
      setDelayCause('');
      loadData();
    } catch (err: any) {
      alert('Ошибка фиксации задержки: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '480px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #ccc', paddingBottom: '12px', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '20px' }}>🚆 ДЕПО СЕЙЧАС</h2>
        <p style={{ margin: '4px 0 0', color: '#666', fontSize: '13px' }}>
          Пользователь: <b>{user ? `${user.first_name}` : 'Тестовый режим'}</b>
        </p>
      </header>

      {view === 'dashboard' ? (
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

          <button 
            onClick={() => setView('add_wagon')}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: '#0088cc',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '15px',
              fontWeight: 'bold',
              cursor: 'pointer',
              marginBottom: '20px'
            }}
          >
            + Зарегистрировать вагон
          </button>

          <h3 style={{ margin: '0 0 10px', fontSize: '16px' }}>Реестр вагонов на территории</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {repairs.length === 0 ? (
              <p style={{ color: '#888', fontSize: '14px' }}>Вагонов пока нет</p>
            ) : (
              repairs.map((item: any) => (
                <div 
                  key={item.repair_id}
                  onClick={() => setSelectedCase(item)}
                  style={{
                    background: item.current_status === '08 REPAIR_PAUSED' ? '#fff5f5' : '#fff',
                    border: item.current_status === '08 REPAIR_PAUSED' ? '1px solid #ffcdd2' : '1px solid #e0e0e0',
                    borderRadius: '8px',
                    padding: '12px',
                    cursor: 'pointer',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 'bold', fontSize: '16px' }}>
                      № {item.wagons?.wagon_number || 'Неизвестен'}
                    </span>
                    <span style={{ 
                      fontSize: '11px', 
                      padding: '3px 8px', 
                      borderRadius: '12px', 
                      background: item.current_status === '08 REPAIR_PAUSED' ? '#ffebee' : item.current_status === '07 IN_REPAIR' ? '#e3f2fd' : '#f5f5f5',
                      color: item.current_status === '08 REPAIR_PAUSED' ? '#c62828' : item.current_status === '07 IN_REPAIR' ? '#1976d2' : '#333',
                      fontWeight: 'bold'
                    }}>
                      {item.current_status}
                    </span>
                  </div>
                  <div style={{ marginTop: '6px', fontSize: '12px', color: '#666', display: 'flex', gap: '12px' }}>
                    <span>Тип: <b>{item.repair_type}</b></span>
                    <span>Род: <b>{item.wagons?.wagon_type}</b></span>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div style={{ background: '#f9f9f9', padding: '16px', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Регистрация вагона</h3>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
            Номер вагона (8 цифр):
            <input 
              type="text" 
              value={wagonNumber} 
              onChange={e => setWagonNumber(e.target.value)}
              placeholder="52839102"
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
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
              <option value="ТОР">ТОР</option>
              <option value="ДР">ДР</option>
              <option value="КР">КР</option>
              <option value="КРП">КРП</option>
              <option value="Модернизация">Модернизация</option>
            </select>
          </label>
          <button onClick={handleCreateRepair} disabled={loading} style={{ width: '100%', padding: '12px', backgroundColor: '#4caf50', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', marginBottom: '8px' }}>
            {loading ? 'Сохранение...' : 'Создать Repair Case'}
          </button>
          <button onClick={() => setView('dashboard')} style={{ width: '100%', padding: '10px', backgroundColor: '#ccc', border: 'none', borderRadius: '6px' }}>
            Отмена
          </button>
        </div>
      )}

      {/* Окно выбора статуса */}
      {selectedCase && !showDelayModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
        }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '20px', width: '100%', maxWidth: '360px' }}>
            <h3 style={{ margin: '0 0 8px' }}>Вагон № {selectedCase.wagons?.wagon_number}</h3>
            <p style={{ fontSize: '13px', color: '#666', margin: '0 0 16px' }}>
              Текущий статус: <b>{selectedCase.current_status}</b>
            </p>
            <p style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px' }}>Выберите новый статус:</p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto', marginBottom: '16px' }}>
              {STATUSES.map(st => (
                <button
                  key={st}
                  disabled={st === selectedCase.current_status || loading}
                  onClick={() => handleUpdateStatus(st)}
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    background: st === '08 REPAIR_PAUSED' ? '#ffebee' : st === selectedCase.current_status ? '#e0e0e0' : '#f5f5f5',
                    border: st === '08 REPAIR_PAUSED' ? '1px solid #ef5350' : '1px solid #ccc',
                    color: st === '08 REPAIR_PAUSED' ? '#c62828' : '#333',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: st === '08 REPAIR_PAUSED' ? 'bold' : 'normal'
                  }}
                >
                  {st === '08 REPAIR_PAUSED' ? '⛔ 08 REPAIR_PAUSED (Заблокировать)' : st}
                </button>
              ))}
            </div>

            <button 
              onClick={() => setSelectedCase(null)}
              style={{ width: '100%', padding: '10px', background: '#333', color: '#fff', border: 'none', borderRadius: '6px' }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Окно фиксации задержки */}
      {showDelayModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
        }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '20px', width: '100%', maxWidth: '360px' }}>
            <h3 style={{ margin: '0 0 8px', color: '#c62828' }}>⛔ Фиксация задержки</h3>
            <p style={{ fontSize: '13px', color: '#666', margin: '0 0 12px' }}>
              Вагон № <b>{selectedCase?.wagons?.wagon_number}</b>
            </p>

            <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px' }}>
              Категория задержки:
              <select 
                value={delayCategory} 
                onChange={e => setDelayCategory(e.target.value)}
                style={{ width: '100%', padding: '8px', marginTop: '4px' }}
              >
                {DELAY_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'block', marginBottom: '16px', fontSize: '13px' }}>
              Причина остановки ремонта:
              <textarea 
                value={delayCause}
                onChange={e => setDelayCause(e.target.value)}
                placeholder="Например: Ожидание поставки боковых рам от заказчика"
                rows={3}
                style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
              />
            </label>

            <button 
              onClick={handleConfirmDelay}
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                backgroundColor: '#d32f2f',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                marginBottom: '8px',
                cursor: 'pointer'
              }}
            >
              {loading ? 'Сохранение...' : 'Заблокировать ремонт'}
            </button>

            <button 
              onClick={() => setShowDelayModal(false)}
              style={{ width: '100%', padding: '8px', background: '#ccc', border: 'none', borderRadius: '6px' }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}