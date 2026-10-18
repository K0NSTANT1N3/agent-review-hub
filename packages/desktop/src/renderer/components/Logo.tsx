/**
 * The Quorum mark: two agents (author, reviewer) whose overlap carries the approval.
 * Same drawing as build/icon.svg; at 32 px and below the check is dropped so the rings stay legible.
 */
export function Logo({ size = 24 }: { size?: number }) {
  const small = size <= 32;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <rect width="64" height="64" rx="15" fill="#1E7A4C" />
      {!small && <path d="M32 21.05A13 13 0 0 1 32 42.95A13 13 0 0 1 32 21.05Z" fill="#fff" />}
      <g fill="none" stroke="#fff" strokeWidth={small ? 6 : 4.5}>
        <circle cx="25" cy="32" r={small ? 12.5 : 13} />
        <circle cx="39" cy="32" r={small ? 12.5 : 13} />
      </g>
      {!small && <path d="M28.7 32.3L31.3 34.9L35.5 29.5" fill="none" stroke="#1E7A4C" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
