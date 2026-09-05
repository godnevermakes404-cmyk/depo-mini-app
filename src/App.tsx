import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import './App.css';

export default function App() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    // Безопасная инициализация Telegram WebApp
    try {
      if (typeof window !== 'undefined' && WebApp && typeof WebApp.ready === 'function') {
        WebApp.ready();
        if (WebApp.initDataUnsafe?.user) {
          setUser(WebApp.initDataUnsafe.user);
        }
      }
    } catch (e) {
      console.log('Запуск в режиме обычного браузера');
    }
  }, []);

  return (
    <div style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '480px', margin: '0 auto' }}>
      {/* Шапка приложения */}
      <header style={{ borderBottom: '1px solid #ccc', paddingBottom: '12px', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '20px' }}>🚆 ДЕПО СЕЙЧАС</h2>
        <p style={{ margin: '4px 0 0', color: '#666', fontSize: '14px' }}>
          Пользователь: <b>{user ? `${user.first_name} (ID: ${user.id})` : 'Тестовый режим (Браузер)'}</b>
        </p>
      </header>

      {/* Оперативный дашборд */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
        <div style={{ background: '#f0f4f8', padding: '12px', borderRadius: '8px' }}>
          <div style={{ fontSize: '12px', color: '#555' }}>На территории</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold' }}>87</div>
        </div>
        <div style={{ background: '#e3f2fd', padding: '12px', borderRadius: '8px' }}>
          <div style={{ fontSize: '12px', color: '#555' }}>В ремонте</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#1976d2' }}>32</div>
        </div>
        <div style={{ background: '#fff3e0', padding: '12px', borderRadius: '8px' }}>
          <div style={{ fontSize: '12px', color: '#555' }}>В очереди</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#ed6c02' }}>18</div>
        </div>
        <div style={{ background: '#ffebee', padding: '12px', borderRadius: '8px' }}>
          <div style={{ fontSize: '12px', color: '#555' }}>Заблокировано</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#d32f2f' }}>9</div>
        </div>
      </div>

      {/* Быстрое действие */}
      <button 
        onClick={() => alert('Нажата кнопка: Зарегистрировать вагон')}
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
    </div>
  );
}