import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFERED_LOCALES } from '@truecairn/shared';
import { hasLanguageChoice } from '../src/i18n/LanguagePicker.js';
import { setLocale } from '../src/i18n/index.js';
import { Login } from '../src/screens/Login.js';

// The passkey ceremony needs a real authenticator (the Playwright E2E covers
// it). Rejecting here is how the error path is reached without one.
vi.mock('../src/auth/passkey.js', () => ({
  loginPasskey: vi.fn(() => Promise.reject(new Error('no authenticator'))),
}));

// End-to-end proof that the pipeline actually renders a second language
// (docs/40 Phase 0) — catalog → i18next → component → DOM. The catalog test
// checks the DATA; this checks that a user switching language sees the switch.

// The i18n runtime is a module singleton, so a locale set in one test leaks into
// the next. Reset to the source language after each.
afterEach(async () => {
  await setLocale('en');
});

const renderAt = (ui: ReactElement): ReturnType<typeof render> =>
  render(<MemoryRouter initialEntries={['/login']}>{ui}</MemoryRouter> as ReactElement);

describe('rendering in Spanish', () => {
  it('starts in English', () => {
    renderAt(<Login />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders the sign-in screen in Spanish after a locale change', async () => {
    await setLocale('es');
    renderAt(<Login />);
    expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Iniciar sesión con tu clave de acceso' }),
    ).toBeInTheDocument();
  });

  // TODAY'S state: Spanish is built and tested but not OFFERED (see
  // OFFERED_LOCALES in packages/shared/src/locale.ts), so the sign-in screen
  // shows no picker at all rather than a one-item dropdown.
  // Was 'shows no picker while only one language is offered'. Spanish was offered
  // on 2026-08-26, so the auth screens now carry the control. The one-language
  // case has not stopped being checked — hasLanguageChoice(['en']) above is the
  // assertion that survives, and it is the one that governs the rendering.
  it('shows the picker on the auth screens now that a second language is offered', () => {
    renderAt(<Login />);
    expect(screen.getByTestId('language-picker')).toBeInTheDocument();
  });

  // The HEADING has to disappear with the control, not just the control.
  //
  // Settings wraps the picker in its own card with a "Language" title, and that
  // card rendered whether or not the picker did — so production showed a titled
  // box with nothing inside it for as long as only English was offered. It reads
  // as a broken setting rather than as a choice that does not exist yet, and it
  // was reported from production that way (2026-08-25).
  //
  // Asserted through the predicate both sides now share, so the two cannot come
  // apart again: a caller that renders a heading must ask the same question the
  // control asks itself.
  it('offers no language section at all when there is no choice to make', () => {
    expect(hasLanguageChoice(['en'])).toBe(false);
    expect(hasLanguageChoice(['en', 'es'])).toBe(true);
    // The default argument is the real gate, and it is what Settings calls.
    expect(hasLanguageChoice()).toBe(OFFERED_LOCALES.length >= 2);
  });

  // TOMORROW'S state, under test now so that flipping OFFERED_LOCALES turns on a
  // control that already works rather than one nobody has driven. The control has
  // to work for someone who cannot read the language it is currently in — that is
  // the whole reason it sits on the auth screens rather than in Settings — so
  // drive it the way they would: pick from the list.
  it('switches language from the picker without a reload', async () => {
    // Login renders its OWN picker now, so driving that one rather than a second
    // instance is both simpler and closer to what a reader actually touches.
    renderAt(<Login />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId('language-picker'), 'es');

    expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    // The picker names each language in itself, so it stays readable after the
    // switch rather than becoming a list the reader can no longer parse.
    expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Español' })).toBeInTheDocument();
  });

  it('sets the document language so screen readers switch voice', async () => {
    await setLocale('es');
    expect(document.documentElement.getAttribute('lang')).toBe('es');
    await setLocale('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  // Errors are held as message KEYS in component state, never as rendered text.
  // This is what that buys: an error ALREADY ON SCREEN re-renders in the new
  // language instead of being frozen in whichever one was active when it fired.
  // Worth a test of its own — storing the rendered string works perfectly until
  // someone switches language while an alert is up, and then it silently does
  // not, which is exactly the kind of bug nobody reports.
  it('re-renders an on-screen error when the language changes', async () => {
    renderAt(<Login />);
    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with your passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not sign you in. Please try again.',
    );

    await userEvent.selectOptions(screen.getByTestId('language-picker'), 'es');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos iniciar tu sesión. Inténtalo de nuevo.',
    );
  });
});
