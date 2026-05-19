import { describe, expect, it } from 'vitest';
import { normalizeMessageEnvelope } from '../src/slack/socketClient.js';

describe('normalizeMessageEnvelope', () => {
  it('extracts the deleted message identity from a message_deleted event', () => {
    // Slack's `message_deleted` payload: `event.ts` and `event.user` describe
    // the deletion notification itself (often empty user), while the *actual*
    // deleted message lives under `event.previous_message`. The downstream
    // processMessageDeleted handler keys on `deletedTs` to find the active
    // job — so we must surface that, not the wrapper.
    const envelope = normalizeMessageEnvelope(
      {
        type: 'message',
        subtype: 'message_deleted',
        channel: 'C0AQMNHHUE9',
        channel_type: 'channel',
        ts: '1779173999.000100', // deletion notification ts (irrelevant for routing)
        deleted_ts: '1779173979.749509', // the deleted message's original ts
        previous_message: {
          ts: '1779173979.749509',
          user: 'U09NC7JDZHD',
          text: '<@UBOT1> hi there',
          thread_ts: '1779173979.749509',
        },
      },
      { event_id: 'Ev0DELETE1' },
    );

    expect(envelope.messageSubtype).toBe('message_deleted');
    expect(envelope.deletedTs).toBe('1779173979.749509');
    expect(envelope.previousMessage).toEqual({
      ts: '1779173979.749509',
      userId: 'U09NC7JDZHD',
      threadTs: '1779173979.749509',
      text: '<@UBOT1> hi there',
    });
    // Routing fields take the original message's values, not the deletion
    // notification's — otherwise the job lookup would key on the wrong ts.
    expect(envelope.userId).toBe('U09NC7JDZHD');
    expect(envelope.threadTs).toBe('1779173979.749509');
    expect(envelope.text).toBe('<@UBOT1> hi there');
    expect(envelope.channelId).toBe('C0AQMNHHUE9');
  });

  it('falls back to event.deleted_ts when previous_message is absent', () => {
    const envelope = normalizeMessageEnvelope(
      {
        type: 'message',
        subtype: 'message_deleted',
        channel: 'C0AQMNHHUE9',
        ts: '1779173999.000100',
        deleted_ts: '1779173979.749509',
      },
      { event_id: 'Ev0DELETE2' },
    );

    expect(envelope.deletedTs).toBe('1779173979.749509');
    expect(envelope.previousMessage).toBeUndefined();
  });

  it('does not populate deletion fields for normal messages', () => {
    const envelope = normalizeMessageEnvelope(
      {
        type: 'message',
        channel: 'C0AQMNHHUE9',
        channel_type: 'channel',
        ts: '1779173998.467699',
        user: 'U09NC7JDZHD',
        text: '<@UBOT1> normal mention',
      },
      { event_id: 'Ev0NORMAL' },
    );

    expect(envelope.messageSubtype).toBeUndefined();
    expect(envelope.deletedTs).toBeUndefined();
    expect(envelope.previousMessage).toBeUndefined();
    expect(envelope.userId).toBe('U09NC7JDZHD');
    expect(envelope.text).toBe('<@UBOT1> normal mention');
  });

  it('defaults threadTs to the event ts for top-level mentions', () => {
    const envelope = normalizeMessageEnvelope(
      {
        type: 'message',
        channel: 'C0AQMNHHUE9',
        ts: '1779173998.467699',
        user: 'U09NC7JDZHD',
        text: '<@UBOT1> top-level',
      },
      { event_id: 'Ev0TOP' },
    );

    expect(envelope.threadTs).toBe('1779173998.467699');
  });
});
