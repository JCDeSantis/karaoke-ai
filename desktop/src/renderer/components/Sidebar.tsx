import type { ViewId } from '../types/electron-api';

const items: Array<{ id: ViewId; label: string; hint: string }> = [
  { id: 'library', label: 'Library', hint: 'Your catalog' },
  { id: 'import', label: 'Import', hint: 'Add a local file' },
  { id: 'queue', label: 'Queue', hint: 'Processing jobs' },
  { id: 'player', label: 'Player', hint: 'Sing along' },
  { id: 'lyrics', label: 'Lyrics', hint: 'Edit transcript' },
  { id: 'settings', label: 'Settings', hint: 'Storage and health' },
];

export interface SidebarProps {
  activeView: ViewId;
  onChange: (view: ViewId) => void;
}

export function Sidebar({ activeView, onChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark">K</div>
        <div>
          <div className="brand-title">KaraokeAI</div>
          <div className="brand-subtitle">Local-first karaoke workstation</div>
        </div>
      </div>

      <nav className="nav-list" aria-label="Primary">
        {items.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activeView === item.id ? 'is-active' : ''}`}
            type="button"
            onClick={() => onChange(item.id)}
          >
            <span className="nav-label">{item.label}</span>
            <span className="nav-hint">{item.hint}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
