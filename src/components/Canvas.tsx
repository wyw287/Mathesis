import { useSession } from '../store/session';
import { ArtifactCard } from './ArtifactCard';

export function Canvas() {
  const artifacts = useSession((s) => s.artifacts);
  const focusId = useSession((s) => s.focusId);

  if (!artifacts.length) {
    return (
      <div className="canvas empty">
        <p className="hint">
          画布还是空的。
          <br />
          让老师画一张图、展开一段推导、出一题，都会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="canvas">
      {artifacts.map((a) => (
        <ArtifactCard key={a.id} artifact={a} focused={a.id === focusId} />
      ))}
    </div>
  );
}
