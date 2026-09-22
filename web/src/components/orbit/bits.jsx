// Small shared presentational bits (the JSX form of the string helpers in components/ui.js).
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Icon, ItemIcon } from '@/lib/icons.jsx';
import { arrowIconName, deltaClass, deltaIconName, isNum, pct, tileUrl } from '@/lib/format.js';

/** Inline delta text "↗ 11.4%" coloured up (red) / down (green). */
export function Delta({ v, digits = 1, suffix = '%' }) {
  if (!isNum(v)) return null;
  return (
    <span className={`delta ${deltaClass(v)}`}>
      <Icon name={arrowIconName(v)} size={13} strokeWidth={2.25} />
      {Math.abs(v).toFixed(digits)}{suffix}
    </span>
  );
}

/** Soft pill "+17%" (up-soft/up). */
export function DChip({ v, digits = 0, suffix = '' }) {
  if (!isNum(v)) return null;
  return <span className={`dchip ${deltaClass(v)}`}>{pct(v, digits)}{suffix ? ' ' + suffix : ''}</span>;
}

/** Design-system delta pill: "+12% in 6 mo". */
export function DeltaPill({ v, suffix = 'in 6 mo', digits = 0 }) {
  if (!isNum(v)) return null;
  const cls = deltaClass(v);
  return (
    <Badge variant={cls === 'up' ? 'up' : cls === 'down' ? 'down' : 'flat'}>
      <Icon name={deltaIconName(v)} />{pct(v, digits)} {suffix}
    </Badge>
  );
}

/** <img> of a satellite tile that swaps to a soft placeholder when the PNG is missing.
 *  Clicking it opens the satellite lightbox (lib/lightbox.js) via the data-sat-* attributes. */
export function SatImg({ regionId, month, alt = '', className = '' }) {
  const [failed, setFailed] = useState(false);
  const src = tileUrl(regionId, month);
  if (!src || failed) return <div className={`sat-img sat-missing ${className}`} />;
  return (
    <img
      className={`sat-img sat ${className}`}
      src={src}
      alt={alt}
      data-sat-region={regionId}
      data-sat-month={month}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Product photo with a lucide fallback, used by the groceries / gpu / track-record thumbnails. */
export function Photo({ id, wrapClass, fallbackClass, fallbackSize = 28, lightbox = false }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={wrapClass} data-no-lightbox={lightbox ? undefined : ''}>
      {failed
        ? <span className={fallbackClass}><ItemIcon id={id} size={fallbackSize} /></span>
        : <img src={`/products/${id}.jpg`} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}
