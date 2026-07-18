import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 16, children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      {children}
    </svg>
  );
}

export function PulseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M3 12h3l2.1-6 3.8 12 2.6-8 1.6 2H21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m14 4 6 6-3 1-3.5 3.5L13 20l-2-2 .5-3.5L15 11l1-3-6-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path d="m4 20 6-6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M3 8 8 3M21 8l-5-5M3 16l5 5M21 16l-5 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m4 9 5-5M20 9l-5-5M4 15l5 5M20 15l-5 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function HideIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5 8.5A8.8 8.8 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.2 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M15.1 15.1A4.4 4.4 0 0 1 12 16.5C6.5 16.5 3 12 3 12a16.7 16.7 0 0 1 2.3-3.2M9.2 9.2a4 4 0 0 0 5.6 5.6M3 3l18 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h8M16 18h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <circle cx="15" cy="6" r="2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="12" r="2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="14" cy="18" r="2" stroke="currentColor" strokeWidth="1.7" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m6 6 12 12M18 6 6 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m5 12 4 4L19 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </IconBase>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M12 4 3.5 19h17L12 4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path d="M12 9v4M12 16h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
    </IconBase>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M6.5 17H6a4 4 0 0 1-1.5-7.7M7.6 5.5A6 6 0 0 1 18 9.6 3.5 3.5 0 0 1 18.5 17H17M3 3l18 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m9 5 7 7-7 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}
