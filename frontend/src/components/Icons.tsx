import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const defaults = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function MessageIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.35-4A9 9 0 1 1 21 12Z" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <rect
        x="7"
        y="7"
        width="10"
        height="10"
        rx="1.5"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="m4 5 16 7-16 7 3-7-3-7Z" />
      <path d="M7 12h13" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M12 3c.5 4.2 2.8 6.5 7 7-4.2.5-6.5 2.8-7 7-.5-4.2-2.8-6.5-7-7 4.2-.5 6.5-2.8 7-7Z" />
      <path d="M19 16c.2 1.7 1.1 2.6 2.8 2.8-1.7.2-2.6 1.1-2.8 2.8-.2-1.7-1.1-2.6-2.8-2.8 1.7-.2 2.6-1.1 2.8-2.8Z" />
    </svg>
  );
}

export function RobotIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 3v4M9 3h6M8.5 12h.01M15.5 12h.01M9 15h6M3 11v4M21 11v4" />
    </svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 9A7 7 0 0 1 18.5 6.5L20 8M4 16l1.5 1.5A7 7 0 0 0 17.9 15" />
    </svg>
  );
}
