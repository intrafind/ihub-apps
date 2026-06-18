import { useId } from 'react';

/**
 * iHub gradient mark. Used as the fallback brand logo across the user and admin
 * sidebars and the start page. The gradient id is unique per instance so
 * multiple logos on the same page don't collide.
 */
export default function IHubLogo({ size = 28, className = '' }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="6" y1="34" x2="34" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#16a34a" />
          <stop offset="1" stopColor="#0ea5b7" />
        </linearGradient>
      </defs>
      <path d="M20 5L34 33H27.2L20 17.5L12.8 33H6L20 5Z" fill={`url(#${gradientId})`} />
    </svg>
  );
}
