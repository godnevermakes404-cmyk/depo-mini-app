import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import './App.css';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<'dashboard' | 'add_wagon'>('dashboard');
  
  // Поля формы регистрации вагона
  const [wagonNumber, setWagonNumber] = useState('');
  const [wagonType, setWagonType] = useState('Полувагон');
  const [ownerType, setOwnerType] = useState('Own');
  const [repairType, setRepairType] = useState('ДР');
  const [loading, setLoading] = useState(false);

  // Счётчики дашборда
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
    fetchStats();
  }, []);

  // Загрузка статистики из Supabase
  async function fetchStats() {
    const { data, error } = await supabase.from('repair_cases').select('current_status');
    if (!error && data) {
      setStats({
        onSite: data.length,
        inRepair: data.filter((d: any) => d.current_status === '07 IN_REPAIR').length,
        inQueue: data.filter((d: any) => d.current_status === '04 QUEUE' || d.current_status === '01 PLANNED').length,
        blocked: data.filter((d: any) => d.current_status === '08 REPAIR_PAUSED').length
      });
    }
  }

  // Создание вагона и нового Repair Case
  async function handleCreateRepair() {
    if (!wagonNumber.trim()) {
      alert('Введите номер вагона');
      return;
    }
    setLoading(true);

    try {
      let wagonId: string | null = null;

      // 1. Проверяем наличие вагона в базе
      const { data: existingWagon } = await supabase
        .from('wagons')
        .select('id')
        .eq('wagon_number', wagonNumber)
        .maybeSingle();

      if (existingWagon) {
        wagonId = existingWagon.id;
      } else {
        // Если вагона нет, создаем его
        const { data: newWagon, error: wagonError } = await supabase
          .from('wagons')
          .insert([{ wagon_number: wagonNumber, wagon_type: wagonType, owner_type: ownerType }])
          .select()
          .single();

        if (wagonError || !newWagon) {
          throw wagonError || new Error('Не удалось создать вагон');
        }
        wagonId = newWagon.id;
      }

      if (!wagonId) {
        throw new Error('Идентификатор вагона не определен');
      }

      // 2. Создаем Repair Case со статусом 01 PLANNED
      const { data: repairCase, error: repairError } = await supabase
        .from('repair_cases')
        .insert([{
          wagon_id: wagonId,
          repair_type: repairType,
          current_status: '01 PLANNED'
        }])
        .select()
        .single();

      if (repairError || !repairCase) {
        throw repairError || new Error('Не удалось создать Repair Case');
      }

      // 3. Записываем первое событие в status_events
      await supabase.from('status_events').insert([{
        repair_id: repairCase.repair_id,
        previous_status: null,
        new_status: '01 PLANNED',
        comment: 'Первоначальная регистрация ремонта'
      }]);

      alert(`Успешно! Создан Repair Case ID:\n${repairCase.repair_id}`);
      setWagonNumber('');
      setView('dashboard');
      fetchStats();
    } catch (err: any) {
      alert('Ошибка при сохранении: ' + (err.message || 'Неизвестная ошибка'));
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
            <div style={{ background: '#f0f4f8', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#555' }}>Всего ремонтов</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold' }}>{stats.onSite}</div>
            </div>
            <div style={{ background: '#e3f2fd', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#555' }}>В ремонте</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#1976d2' }}>{stats.inRepair}</div>
            </div>
            <div style={{ background: '#fff3e0', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#555' }}>В очереди / Запланировано</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#ed6c02' }}>{stats.inQueue}</div>
            </div>
            <div style={{ background: '#ffebee', padding: '12px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#555' }}>Заблокировано</div>
              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#d32f2f' }}>{stats.blocked}</div>
            </div>
          </div>

          <button 
            onClick={() => setView('add_wagon')}
            style={{
              width: '100%',
              padding: '14px',
              backgroundColor: '#0088cc',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            + Зарегистрировать вагон
          </button>
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
              placeholder="например, 52839102"
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
            Род вагона:
            <select 
              value={wagonType} 
              onChange={e => setWagonType(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '4px' }}
            >
              <option value="Полувагон">Полувагон</option>
              <option value="Цистерна">Цистерна</option>
              <option value="Крытый">Крытый</option>
              <option value="Платформа">Платформа</option>
              <option value="Хоппер">Хоппер</option>
            </select>
          </label>

          <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
            Собственность:
            <select 
              value={ownerType} 
              onChange={e => setOwnerType(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '4px' }}
            >
              <option value="Own">Собственный (Own)</option>
              <option value="Third-party">Сторонний (Client)</option>
            </select>
          </label>

          <label style={{ display: 'block', marginBottom: '16px', fontSize: '14px' }}>
            Вид ремонта:
            <select 
              value={repairType} 
              onChange={e => setRepairType(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '4px' }}
            >
              <option value="ТОР">ТОР</option>
              <option value="ДР">ДР</option>
              <option value="КР">КР</option>
              <option value="КРП">КРП</option>
              <option value="Модернизация">Модернизация</option>
            </select>
          </label>

          <button 
            onClick={handleCreateRepair}
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: '#4caf50',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 'bold',
              cursor: 'pointer',
              marginBottom: '8px'
            }}
          >
            {loading ? 'Сохранение...' : 'Создать Repair Case'}
          </button>

          <button 
            onClick={() => setView('dashboard')}
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: '#ccc',
              color: '#333',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              cursor: 'pointer'
            }}
          >
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}