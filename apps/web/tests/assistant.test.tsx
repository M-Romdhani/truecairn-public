import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Assistant } from '../src/screens/assistant/Assistant.js';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// The Assistant renders the shared <AiDisclosure> (a router <Link> to the AI
// transparency page), so mount it inside a router as it always is in the app.
const renderAssistant = (fetchImpl: typeof fetch): void => {
  render(
    <MemoryRouter>
      <Assistant fetchImpl={fetchImpl} />
    </MemoryRouter>,
  );
};

afterEach(() => vi.restoreAllMocks());

describe('Assistant', () => {
  it('asks a question and shows the answer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/ai/assist'))
        return json({ answer: 'You add one from the Contacts page.' });
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    renderAssistant(fetchImpl);
    await userEvent.type(screen.getByLabelText(/your question/i), 'How do I add a contact?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() =>
      expect(screen.getByTestId('assistant-answer')).toHaveTextContent(/Contacts page/),
    );
  });

  it('shows an error when the assistant is unavailable (fail-soft)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/ai/assist')) return json({ answer: null, reason: 'disabled' });
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    renderAssistant(fetchImpl);
    await userEvent.type(screen.getByLabelText(/your question/i), 'Anything?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/i));
  });
});
