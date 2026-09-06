export const ALL_STATUSES = [
  '01 PLANNED', '02 APPROACH', '03 ARRIVED', '04 QUEUE', '05 DEFECTATION',
  '06 READY_FOR_REPAIR', '07 IN_REPAIR', '08 REPAIR_PAUSED', '09 QUALITY_CONTROL',
  '10 ACCEPTANCE', '11 READY_TO_DISPATCH', '12 DISPATCH_WAIT', '13 DISPATCHED',
  '14 CLOSED', '15 CANCELLED'
] as const;

export const STATUS_RU: Record<string, string> = {
  '01 PLANNED': 'План',
  '02 APPROACH': 'В подходе',
  '03 ARRIVED': 'Прибыл',
  '04 QUEUE': 'В очереди',
  '05 DEFECTATION': 'Дефектовка',
  '06 READY_FOR_REPAIR': 'Готов к ремонту',
  '07 IN_REPAIR': 'В ремонте',
  '08 REPAIR_PAUSED': 'Задержка',
  '09 QUALITY_CONTROL': 'ОТК / ВК',
  '10 ACCEPTANCE': 'Приёмка',
  '11 READY_TO_DISPATCH': 'Готов к отправке',
  '12 DISPATCH_WAIT': 'Ожидание отправки',
  '13 DISPATCHED': 'Отправлен',
  '14 CLOSED': 'Закрыт',
  '15 CANCELLED': 'Отменён'
};

export const ON_SITE_STATUSES = [
  '03 ARRIVED', '04 QUEUE', '05 DEFECTATION', '06 READY_FOR_REPAIR',
  '07 IN_REPAIR', '08 REPAIR_PAUSED', '09 QUALITY_CONTROL', '10 ACCEPTANCE',
  '11 READY_TO_DISPATCH', '12 DISPATCH_WAIT'
];

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  '01 PLANNED': ['02 APPROACH', '03 ARRIVED', '15 CANCELLED'],
  '02 APPROACH': ['03 ARRIVED', '15 CANCELLED'],
  '03 ARRIVED': ['04 QUEUE'],
  '04 QUEUE': ['05 DEFECTATION'],
  '05 DEFECTATION': ['06 READY_FOR_REPAIR'],
  '06 READY_FOR_REPAIR': ['07 IN_REPAIR'],
  '07 IN_REPAIR': ['08 REPAIR_PAUSED', '09 QUALITY_CONTROL'],
  '08 REPAIR_PAUSED': ['07 IN_REPAIR'],
  '09 QUALITY_CONTROL': ['07 IN_REPAIR', '10 ACCEPTANCE'],
  '10 ACCEPTANCE': ['11 READY_TO_DISPATCH'],
  '11 READY_TO_DISPATCH': ['12 DISPATCH_WAIT', '13 DISPATCHED'],
  '12 DISPATCH_WAIT': ['13 DISPATCHED'],
  '13 DISPATCHED': ['14 CLOSED'],
  '14 CLOSED': [],
  '15 CANCELLED': []
};

export interface DQViolation {
  repair_id: string;
  wagon_number: string;
  code: string;
  severity: 'CRITICAL' | 'WARNING';
  message: string;
}

export interface RepairTimeMetrics {
  total_dwell_hours: number;
  queue_hours: number;
  gross_repair_hours: number;
  paused_hours: number;
  net_repair_hours: number;
}

export function runDataQualityChecks(repairs: any[], delays: any[]): DQViolation[] {
  const violations: DQViolation[] = [];
  const now = new Date().getTime();

  repairs.forEach(r => {
    const activeDelays = delays.filter(d => d.repair_id === r.repair_id && !d.end_datetime);
    const wagonNum = r.wagons?.wagon_number || 'Неизвестный';

    if (r.sla_deadline && new Date(r.sla_deadline).getTime() < now && activeDelays.length === 0 && ON_SITE_STATUSES.includes(r.current_status)) {
      violations.push({ repair_id: r.repair_id, wagon_number: wagonNum, code: 'OVERDUE_NO_BLOCKER', severity: 'CRITICAL', message: 'Просрочен по SLA, но задержка не зафиксирована' });
    }

    if (r.current_status === '08 REPAIR_PAUSED') {
      activeDelays.forEach(d => {
        if (!d.next_action || !d.responsible_party) {
          violations.push({ repair_id: r.repair_id, wagon_number: wagonNum, code: 'BLOCKED_NO_ACTION', severity: 'CRITICAL', message: 'Задержка без ответственного или Next Action' });
        }
      });
    }

    if (r.forecast_release && r.sla_deadline && new Date(r.forecast_release).getTime() > new Date(r.sla_deadline).getTime()) {
      violations.push({ repair_id: r.repair_id, wagon_number: wagonNum, code: 'FORECAST_EXCEEDS_SLA', severity: 'WARNING', message: 'Прогноз выпуска превышает норматив SLA договора' });
    }
  });

  return violations;
}

export function calculateLostWagonDays(delays: any[]): { totalDays: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, number> = {};
  let totalHours = 0;

  delays.filter(d => d.delay_type === 'PRIMARY').forEach(d => {
    const start = new Date(d.start_datetime).getTime();
    const end = d.end_datetime ? new Date(d.end_datetime).getTime() : new Date().getTime();
    const durationHours = Math.max(0, (end - start) / (1000 * 60 * 60));

    totalHours += durationHours;
    byCategory[d.category] = (byCategory[d.category] || 0) + (durationHours / 24);
  });

  return { totalDays: Number((totalHours / 24).toFixed(1)), byCategory };
}