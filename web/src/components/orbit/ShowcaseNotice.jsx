// Banner on pages whose live actions are locked in the public showcase build.
import { Icon } from '@/lib/icons.jsx';
import { useMode } from '@/lib/mode.js';

export default function ShowcaseNotice({ what = 'Live scans', text }) {
  const { showcase } = useMode();
  if (!showcase) return null;
  return (
    <div className="showcase-note" role="note">
      <Icon name="lock" size={16} />
      <div>
        <b>{what} are switched off on this public demo.</b>{' '}
        {text || <>You&apos;re seeing the latest data, recorded live on stage at the {'{Tech: Europe}'} hackathon. We turned off the
        Jev, DeepSeek and Modal runs so the demo doesn&apos;t burn through tokens. <b>Replay</b> plays back that on-stage scan;
        clone the repo and run Orbit locally to scan live.</>}
      </div>
    </div>
  );
}
