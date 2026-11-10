import { initials } from '@/lib/format';

export function Avatar({
  name,
  src,
  size = 38,
  green = false,
}: {
  name: string;
  src?: string | null;
  size?: number;
  green?: boolean;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  // eslint-disable-next-line @next/next/no-img-element
  if (src)
    return <img className="avatar" src={src} alt="" style={style} referrerPolicy="no-referrer" />;
  return (
    <span className={`avatar${green ? ' avatar--green' : ''}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
