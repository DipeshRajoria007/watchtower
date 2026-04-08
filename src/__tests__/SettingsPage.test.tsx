import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsPage } from '../pages/SettingsPage';
import type { AppSettings } from '../types';

function makeSettings(): AppSettings {
  return {
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    ownerSlackUserIds: 'UOWNER1',
    botUserId: 'UBOT1',
    bugsAndUpdatesChannelId: 'C01H25RNLJH',
    newtonWebPath: '/Users/dipesh/code/newton-web',
    newtonApiPath: '/Users/dipesh/code/newton-api',
    maxConcurrentJobs: 2,
    repoClassifierThreshold: 0.75,
    themePreset: 'watchtower-midnight',
    themeBackgroundColor: '#06090C',
    themeForegroundColor: '#F2F7FB',
    themeAccentColor: '#53D2FF',
    themeFontFamily: 'ibm-plex',
    successNotificationAudioMode: 'off',
    successNotificationAudioDefaultSound: 'glass',
    successNotificationAudioCustomPath: '',
    failureNotificationAudioMode: 'off',
    failureNotificationAudioDefaultSound: 'glass',
    failureNotificationAudioCustomPath: '',
    agentBackend: 'codex',
    coreDevSlackUserIds: '',
    coreDevSlackUserGroup: '',
    accessControl: {
      mode: 'audit',
      groups: {
        viewer: {
          slackUserGroupHandle: '',
          manualUserIds: 'UVIEWER',
          allowedChannelIds: 'C-VIEW',
          allowIm: true,
          allowMpim: false,
        },
        reviewer: {
          slackUserGroupHandle: '',
          manualUserIds: 'UREVIEW',
          allowedChannelIds: 'C-REVIEW',
          allowIm: false,
          allowMpim: false,
        },
        builder: {
          slackUserGroupHandle: '',
          manualUserIds: 'UBUILDER',
          allowedChannelIds: 'C-BUILD',
          allowIm: false,
          allowMpim: false,
        },
        admin: {
          slackUserGroupHandle: '',
          manualUserIds: 'UADMIN',
          allowedChannelIds: 'C-ADMIN',
          allowIm: true,
          allowMpim: true,
        },
      },
    },
  };
}

describe('SettingsPage', () => {
  it('renders the access-control section and group cards', () => {
    render(
      <SettingsPage
        onSettingsChange={vi.fn()}
        onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
        onPreviewNotification={vi.fn()}
        onSubmit={vi.fn()}
        previewingNotificationTone={null}
        savingSettings={false}
        settings={makeSettings()}
        settingsConfigured
        settingsMessage={null}
        uploadingNotificationAudioTone={null}
      />,
    );

    expect(screen.getAllByText('Access Control').length).toBeGreaterThan(0);
    expect(screen.getByText('Viewer')).toBeTruthy();
    expect(screen.getByText('Reviewer')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy();
  });

  it('maps access mode and DM toggle changes into onSettingsChange', () => {
    const onSettingsChange = vi.fn();
    render(
      <SettingsPage
        onSettingsChange={onSettingsChange}
        onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
        onPreviewNotification={vi.fn()}
        onSubmit={vi.fn()}
        previewingNotificationTone={null}
        savingSettings={false}
        settings={makeSettings()}
        settingsConfigured
        settingsMessage={null}
        uploadingNotificationAudioTone={null}
      />,
    );

    const accessMode = screen.getByDisplayValue('Audit');
    fireEvent.change(accessMode, { target: { value: 'enforce' } });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accessControl: expect.objectContaining({
          mode: 'enforce',
        }),
      }),
    );

    onSettingsChange.mockClear();
    const allowDmToggles = screen.getAllByLabelText('Allow DM');
    fireEvent.click(allowDmToggles[1]);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accessControl: expect.objectContaining({
          groups: expect.objectContaining({
            reviewer: expect.objectContaining({
              allowIm: true,
            }),
          }),
        }),
      }),
    );
  });
});
