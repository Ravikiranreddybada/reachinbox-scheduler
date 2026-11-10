'use client';
import { useState } from 'react';
import { Check, LogOut, Unlink } from 'lucide-react';
import { API, request } from '@/lib/api';
import { useApp } from './AppProvider';

function SlackGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#E01E5A"
        d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 0 1-5.04 0v-6.32z"
      />
      <path
        fill="#36C5F0"
        d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04h6.31z"
      />
      <path
        fill="#2EB67D"
        d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 0 1 5.04 0v6.31z"
      />
      <path
        fill="#ECB22E"
        d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 0 1 0 5.04h-6.31z"
      />
    </svg>
  );
}

/** Slack alert connection plus sign-out, pinned to the bottom of the sidebar. */
export function SlackCard() {
  const { user, toast, signOut } = useApp();
  const [busy, setBusy] = useState(false);
  const slack = user.slackConnection;

  async function disconnect() {
    setBusy(true);
    try {
      await request('/auth/slack', { method: 'DELETE' });
      toast('Slack disconnected. Alerts are paused.');
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not disconnect Slack.', 'error');
      setBusy(false);
    }
  }

  return (
    <div className="side-foot">
      <div className="slack-card">
        <SlackGlyph />
        <div className="slack-text">
          <strong>Slack alerts</strong>
          <span>
            {slack ? (
              <>
                <Check size={12} aria-hidden="true" />{' '}
                {slack.channelName ?? slack.teamName ?? 'Connected'}
              </>
            ) : (
              'Get pinged at your hourly limit'
            )}
          </span>
        </div>
        {slack ? (
          <button
            className="icon-btn"
            aria-label="Disconnect Slack"
            title="Disconnect Slack"
            onClick={() => void disconnect()}
            disabled={busy}
          >
            <Unlink size={17} />
          </button>
        ) : (
          <a className="slack-connect" href={`${API}/auth/slack`}>
            Connect Slack
          </a>
        )}
      </div>
      <button className="signout" onClick={() => void signOut()}>
        <LogOut size={17} strokeWidth={1.6} aria-hidden="true" /> Log out
      </button>
    </div>
  );
}
