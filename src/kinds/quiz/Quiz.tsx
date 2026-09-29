import { useState } from 'react';
import type { CanvasEvent, QuizSpec } from '../../types/artifact';
import { Markdown } from '../../renderers/Markdown';

interface Props {
  spec: QuizSpec;
  artifactId: string;
  emit: (e: CanvasEvent) => void;
}

export function Quiz({ spec, artifactId, emit }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const toggleChoice = (id: string) => {
    if (submitted) return;
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = () => {
    setSubmitted(true);
    emit({
      type: 'answer',
      artifactId,
      response: spec.choices ? { choice: selected.join(',') } : { text },
    });
  };

  const correct =
    submitted && spec.answerKey
      ? selected.length === spec.answerKey.length && selected.every((s) => spec.answerKey!.includes(s))
      : undefined;

  return (
    <div className="quiz">
      <div className="quiz-question">
        <Markdown source={spec.question} />
      </div>

      {spec.choices ? (
        <div className="quiz-choices">
          {spec.choices.map((c) => {
            const picked = selected.includes(c.id);
            const isKey = submitted && spec.answerKey?.includes(c.id);
            const cls = [
              'choice',
              picked ? 'picked' : '',
              isKey ? 'key' : '',
              submitted && picked && !isKey ? 'wrong' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button key={c.id} className={cls} onClick={() => toggleChoice(c.id)} disabled={submitted}>
                <span className="choice-id">{c.id}</span>
                <span className="choice-text">
                  <Markdown source={c.text} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <textarea
          className="quiz-input"
          rows={3}
          placeholder={spec.freeformPlaceholder ?? '写下你的思路…'}
          value={text}
          disabled={submitted}
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {!submitted ? (
        <button className="primary-btn" onClick={submit} disabled={spec.choices ? !selected.length : !text.trim()}>
          提交
        </button>
      ) : (
        <div className="quiz-result">
          {correct !== undefined && (
            <div className={correct ? 'verdict ok' : 'verdict bad'}>{correct ? '✓ 正确' : '✗ 不对，再想想为什么'}</div>
          )}
          {spec.explanation && (
            <div className="quiz-explanation">
              <Markdown source={spec.explanation} />
            </div>
          )}
          <p className="hint">已把你的答案发给老师，可以继续说你的思路。</p>
        </div>
      )}
    </div>
  );
}
