import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { supabase } from './supabase';
import { STATUS_RU, ON_SITE_STATUSES } from './depoEngine';
import './App.css';

declare global { interface Window { Telegram: any; } }

type AppTab = 'wagons' | 'analytics' | 'profile';

const SHOPS = [
  { key: 'bogie', label: 'Тележечный цех' },
  { key: 'wheels', label: 'Колёсный цех' },
  { key: 'brakes', label: 'Автотормозной цех' },
  { key: 'body', label: 'Кузовной / Сварочный' }
];

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [currentTab, setCurrentTab] = useState<AppTab>('wagons');
  const [showAddModal, setShowAddModal] = useState(false);

  const [repairs, setRepairs] = useState<any[]>([]);
  const [selectedCase, setSelectedCase] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Форма добавления вагона
  const [wagonNumber, setWagonNumber] = useState('');
  const [repairType, setRepairType] = useState('ДР');
  const [owner, setOwner] = useState('ПРОМТРАНС');

  // Форма назначения на путь
  const [track, setTrack] = useState('Путь 1');
  const [position, setPosition] = useState('Позиция 1');

  useEffect(() => { initAuthAndData(); }, []);

  async function initAuthAndData() {
    let tgUser: any = null;
    try {
      const tg = window.Telegram?.WebApp || WebApp;
      if (tg) { tg.ready(); tg.expand(); tgUser = tg.initDataUnsafe?.user; }
    } catch (e) {}

    setUser({
      id: '00000000-0000-0000-0000-000000000000',
      name: tgUser ? `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() : 'Мастер / Диспетчер'
    });
    loadData();
  }

  async function loadData() {
    const { data } = await supabase.from('repair_cases').select(`
        repair_id, current_status, repair_type, created_at, track_number, position_number, shop_signatures,
        wagons ( wagon_number, owner )
      `).order('created_at', { ascending: false });

    if (data) setRepairs(data);
  }

  // 1. Создание вагона (Прибыл -> Комиссионная дефектовка)
  async function handleCreateRepair() {
    if (!wagonNumber.trim() || wagonNumber.length !== 8) {
      alert('Введите 8-значный номер вагона');
      return;
    }
    setLoading(true);

    const { error } = await supabase.rpc('create_repair_case', {
      p_wagon_number: wagonNumber,
      p_repair_type: repairType,
      p_user_id: user?.id
    });

    if (!error) {
      setWagonNumber('');
      setShowAddModal(false);
      loadData();
    } else {
      alert('Ошибка: ' + error.message);
    }
    setLoading(false);
  }

  // 2. Подпись Акта мастером цеха
  async function handleSignAct(shopKey: string) {
    if (!selectedCase) return;
    setLoading(true);

    const { data: updatedSigs, error } = await supabase.rpc('sign_defect_act', {
      p_repair_id: selectedCase.repair_id,
      p_shop_key: shopKey,
      p_user_name: user?.name || 'Мастер цеха'
    });

    if (!error) {
      setSelectedCase({ ...selectedCase, shop_signatures: updatedSigs });
      loadData();
    }
    setLoading(false);
  }

  // 3. Завоз на путь или отправка в очередь
  async function handleAssignPosition(toRepair: boolean) {
    if (!selectedCase) return;
    setLoading(true);

    const { error } = await supabase.rpc('assign_repair_position', {
      p_repair_id: selectedCase.repair_id,
      p_track: toRepair ? track : null,
      p_position: toRepair ? position : null,
      p_user_id: user?.id
    });

    if (!error) {
      setSelectedCase(null);
      loadData();
    } else {
      alert('Ошибка: ' + error.message);
    }
    setLoading(false);
  }

  const allSigned = selectedCase?.shop_signatures && SHOPS.every(s => selectedCase.shop_signatures[s.key]?.signed);

  return (
    <div>
      <header className="brand-header">
        <h1 className="brand-title">ДЕПО TMS</h1>
        <span className="status-pill">{user?.name}</span>
      </header>

      <div className="content-area">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>Вагоны на депо ({repairs.length})</h3>
        </div>

        {repairs.map((item: any) => (
          <div key={item.repair_id} className="premium-card" onClick={() => setSelectedCase(item)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '16px', fontWeight: '800' }}>№ {item.wagons?.wagon_number}</span>
              <span className="status-pill">{STATUS_RU[item.current_status] || item.current_status}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{item.repair_type} • {item.wagons?.owner}</span>
              <span>{item.track_number ? `${item.track_number}, ${item.position_number}` : 'Путь не назначен'}</span>
            </div>
          </div>
        ))}

        <button className="fab" onClick={() => setShowAddModal(true)}>+</button>
      </div>

      {/* Модалка: Регистрация прибытия вагона */}
      {showAddModal && (
        <div className="backdrop">
          <div className="bottom-sheet">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>Прибытие вагона на депо</h3>
            <input className="input-field" type="number" value={wagonNumber} onChange={e => setWagonNumber(e.target.value)} placeholder="Номер вагона (8 цифр)" />
            <select className="select-field" value={repairType} onChange={e => setRepairType(e.target.value)}>
              <option value="ДР">Деповской ремонт (ДР)</option>
              <option value="КР">Капитальный ремонт (КР)</option>
              <option value="ТОР">Текущий отцепочный (ТОР)</option>
            </select>
            <input className="input-field" type="text" value={owner} onChange={e => setOwner(e.target.value)} placeholder="Собственник" />
            
            <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
              <button className="btn-secondary" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleCreateRepair} disabled={loading}>Принять на депо</button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка: Дефектовка и Назначение позиции */}
      {selectedCase && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedCase(null); }}>
          <div className="bottom-sheet">
            <div className="sheet-handle"></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '18px' }}>№ {selectedCase.wagons?.wagon_number}</h3>
              <button onClick={() => setSelectedCase(null)} style={{ background: 'transparent', border: 'none', fontSize: '18px' }}>✕</button>
            </div>

            {/* ШАГ 1: Комиссионный Акт ВУ-22 */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>
                📝 ШАГ 1. Комиссионный Акт дефектации (ВУ-22)
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {SHOPS.map(s => {
                  const sig = selectedCase.shop_signatures?.[s.key];
                  return (
                    <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>
                      <div>
                        <b>{s.label}</b>
                        {sig?.signed && <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Подписал: {sig.master_name}</div>}
                      </div>
                      {sig?.signed ? (
                        <span style={{ color: 'var(--success)', fontWeight: 'bold' }}>✓ Подписано</span>
                      ) : (
                        <button className="btn-primary" style={{ width: 'auto', padding: '4px 8px', fontSize: '10px' }} onClick={() => handleSignAct(s.key)} disabled={loading}>
                          Подписать
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ШАГ 2: Диспетчеризация и завоз на позиции */}
            <div className="premium-card">
              <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--brand-color)' }}>
                🏗️ ШАГ 2. Размещение вагона
              </h4>
              {!allSigned && (
                <div style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '8px' }}>
                  ⚠️ Завоз на позиции станет доступен после подписи акта всеми мастерами цехов.
                </div>
              )}

              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                <select className="select-field" style={{ margin: 0 }} value={track} onChange={e => setTrack(e.target.value)}>
                  <option value="Путь 1">Путь №1</option>
                  <option value="Путь 2">Путь №2</option>
                  <option value="Путь 3">Путь №3</option>
                </select>
                <select className="select-field" style={{ margin: 0 }} value={position} onChange={e => setPosition(e.target.value)}>
                  <option value="Позиция 1">Позиция 1</option>
                  <option value="Позиция 2">Позиция 2</option>
                  <option value="Позиция 3">Позиция 3</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn-secondary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(false)} disabled={loading || !allSigned}>
                  ⏳ В очередь (Нет мест)
                </button>
                <button className="btn-primary" style={{ flex: 1, fontSize: '11px' }} onClick={() => handleAssignPosition(true)} disabled={loading || !allSigned}>
                  ➡️ Завезти на путь
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}