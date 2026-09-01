import { useState, type FormEvent } from 'react';
import { aiAssist } from '../../ai/api.js';
import { AiDisclosure } from '../../ai/AiDisclosure.js';
import { detectSensitiveInput } from '../../ai/sensitive.js';
import { useT, type TranslationKey } from '../../i18n/useT.js';

// In-app help assistant (Build with Gemini XPRIZE). The question is the user's own
// words sent to Gemini (owner-consented input); the server adds only safe metadata
// and the model is instructed never to request or echo secrets — reinforced by the
// visible "don't paste secrets" note below.
// Message keys, not sentences: these are sent to the model AS THE QUESTION when
// tapped, so they must be in the reader's language — asking in Spanish and being
// answered in English would be the worst of both.
const SUGGESTIONS: readonly TranslationKey[] = [
  'assistant.suggestion.release',
  'assistant.suggestion.passphrase',
  'assistant.suggestion.s2',
];

export function Assistant({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element {
  const t = useT();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  async function ask(q: string): Promise<void> {
    if (q.trim() === '') return;
    // Defence-in-depth beneath the model's refusal (QA Finding 4): if the text
    // looks like it contains a passphrase / recovery code, block it HERE so the
    // sensitive string never leaves the device at all.
    if (detectSensitiveInput(q)) {
      setAnswer(null);
      setError('assistant.error.sensitive');
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await aiAssist(q, fetchImpl);
      if (r.answer === null) setError('assistant.error.unavailable');
      else setAnswer(r.answer);
    } catch {
      setError('assistant.error.generic');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="assistant" className="app-col">
      <header className="page-head">
        <div>
          <div className="hint">{t('assistant.eyebrow')}</div>
          <h1 id="assistant" className="h-page">
            {t('assistant.heading')}
          </h1>
          <p className="small t-2">{t('assistant.lede')}</p>
        </div>
      </header>

      <div className="stack gap-md">
        <section className="card card-pad stack gap-md">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void ask(question);
            }}
            className="stack gap-sm"
          >
            <label className="field-label" htmlFor="assistant-q">
              {t('assistant.field.question')}
            </label>
            <textarea
              id="assistant-q"
              className="input"
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t('assistant.placeholder')}
            />
            <p className="small t-3" role="note">
              {t('assistant.note')}
            </p>
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || question.trim() === ''}>
                {busy ? t('assistant.thinking') : t('assistant.ask')}
              </button>
            </div>
          </form>
          <div className="row gap-sm wrap">
            {SUGGESTIONS.map((key) => (
              <button
                key={key}
                type="button"
                className="btn ghost sm"
                disabled={busy}
                onClick={() => {
                  setQuestion(t(key));
                  void ask(t(key));
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <AiDisclosure />
        </section>

        {answer !== null && (
          <section className="card card-pad" data-testid="assistant-answer">
            <p className="body pre-wrap">{answer}</p>
          </section>
        )}
        {error !== null && (
          <p role="alert" className="alert">
            {t(error)}
          </p>
        )}
      </div>
    </section>
  );
}
