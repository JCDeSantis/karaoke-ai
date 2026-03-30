export interface StatusPillProps {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: string;
}

export function StatusPill({ tone, children }: StatusPillProps) {
  return <span className={`status-pill tone-${tone}`}>{children}</span>;
}

