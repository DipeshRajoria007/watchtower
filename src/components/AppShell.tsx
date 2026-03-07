import type { ReactNode } from 'react';
import { getSidecarTone, humanizeToken } from '../lib/formatters';
import type { AppView } from '../types';
import {
  CloseIcon,
  IntelligenceIcon,
  LaunchpadIcon,
  MenuIcon,
  OverviewIcon,
  RunsIcon,
  SettingsIcon,
  WatchtowerIcon,
} from './icons';

type AppShellProps = {
  children: ReactNode;
  currentView: AppView;
  failuresCount: number;
  navDrawerOpen: boolean;
  onNavigate: (view: AppView) => void;
  onToggleNavDrawer: () => void;
  settingsRequired: boolean;
  sidecarStatus: string;
};

type NavItem = {
  view: AppView;
  label: string;
  helper: string;
  icon: ReactNode;
  badge?: string | number | null;
  badgeTone?: 'danger' | 'warning' | 'info';
};

export function AppShell({
  children,
  currentView,
  failuresCount,
  navDrawerOpen,
  onNavigate,
  onToggleNavDrawer,
  settingsRequired,
  sidecarStatus,
}: AppShellProps) {
  const navItems: NavItem[] = [
    {
      view: 'launchpad',
      label: 'Launchpad',
      helper: 'Draft the Slack command and choose the assistant that should run it.',
      icon: <LaunchpadIcon />,
    },
    {
      view: 'overview',
      label: 'Overview',
      helper: 'Sidecar status, queue pressure, and what needs attention next.',
      icon: <OverviewIcon />,
    },
    {
      view: 'runs',
      label: 'Runs',
      helper: 'Inspect active jobs, failures, recent work, and live diagnostics.',
      icon: <RunsIcon />,
      badge: failuresCount > 0 ? failuresCount : null,
      badgeTone: failuresCount > 0 ? 'danger' : 'info',
    },
    {
      view: 'intelligence',
      label: 'Intelligence',
      helper: 'Recommendations, adaptive signals, and channel heat.',
      icon: <IntelligenceIcon />,
    },
    {
      view: 'settings',
      label: 'Settings',
      helper: 'Slack auth, repo boundaries, runtime limits, and appearance.',
      icon: <SettingsIcon />,
      badge: settingsRequired ? 'Required' : null,
      badgeTone: settingsRequired ? 'warning' : 'info',
    },
  ];

  const sidecarTone = getSidecarTone(sidecarStatus);

  const renderNav = (variant: 'rail' | 'drawer') => (
      <div className={variant === 'drawer' ? 'sidebar-frame expanded' : 'sidebar-frame'}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <WatchtowerIcon />
          </div>
        <div className="brand-copy">
          <span className="eyebrow brand-eyebrow">Developer Automation Console</span>
          <div className="brand-title-row">
            <strong>Watchtower</strong>
            <div
              className={`sidebar-status sidebar-status-${sidecarTone}`}
              aria-label={`Sidecar status: ${humanizeToken(sidecarStatus)}`}
              title={`Sidecar status: ${humanizeToken(sidecarStatus)}`}
            >
              <span className="sidebar-status-dot" />
            </div>
          </div>
        </div>

        <button
          className="icon-button sidebar-menu-trigger"
          type="button"
          aria-label={variant === 'drawer' ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={onToggleNavDrawer}
        >
          {variant === 'drawer' ? <CloseIcon /> : <MenuIcon />}
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {navItems.map(item => (
          <button
            key={item.view}
            type="button"
            className={item.view === currentView ? 'nav-button active' : 'nav-button'}
            aria-current={item.view === currentView ? 'page' : undefined}
            title={variant === 'rail' ? item.label : undefined}
            onClick={() => {
              onNavigate(item.view);
              if (variant === 'drawer') {
                onToggleNavDrawer();
              }
            }}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-copy">
              <span className="nav-row">
                <span className="nav-label">{item.label}</span>
                {item.badge ? (
                  <span className={`nav-badge nav-badge-${item.badgeTone ?? 'info'}`}>{item.badge}</span>
                ) : null}
              </span>
              <span className="nav-helper">{item.helper}</span>
            </span>
          </button>
        ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-pill-row">
            <span className={`status-badge ${sidecarTone === 'good' ? 'success' : sidecarTone === 'danger' ? 'failed' : sidecarTone === 'warn' ? 'warn' : 'info'}`}>
              {humanizeToken(sidecarStatus)}
            </span>
            <span className={`status-badge ${settingsRequired ? 'warn' : 'success'}`}>
              {settingsRequired ? 'Setup needed' : 'Runtime ready'}
            </span>
          </div>
          <p>Atmospheric control room for autonomous Slack workflows.</p>
          <span>Draft commands, inspect traces, follow learned signals, and adjust runtime controls without losing live context.</span>
        </div>
      </div>
  );

  return (
    <main className="desktop-shell">
      <aside className="shell-sidebar">{renderNav('rail')}</aside>

      <div
        className={navDrawerOpen ? 'nav-drawer-overlay open' : 'nav-drawer-overlay'}
        onClick={onToggleNavDrawer}
      />

      <aside className={navDrawerOpen ? 'nav-drawer open' : 'nav-drawer'}>{renderNav('drawer')}</aside>

      <section className="shell-content">
        <div className="content-scroll">
          <div className="content-inner">
            {settingsRequired ? (
              <div className="global-banner">
                <div>
                  <strong>Settings required.</strong>
                  <span>Runtime config is incomplete, so the sidecar will remain paused until the Settings page is complete.</span>
                </div>
                <button type="button" onClick={() => onNavigate('settings')}>
                  Open Settings
                </button>
              </div>
            ) : null}

            {children}
          </div>
        </div>
      </section>
    </main>
  );
}
