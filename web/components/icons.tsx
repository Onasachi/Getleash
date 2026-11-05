/** GetLeash icons (Claude Design, stage 2): 20 × 20 grid, 1.75 stroke, drawn in currentColor. Use at 16 or 20 px. */
import type { SVGProps } from "react";

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "children">;

function make(d: string) {
  return function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
        <path d={d} />
      </svg>
    );
  };
}

export const CheckIcon = make("M5 10.5l3.2 3.2L15 7");
export const CrossIcon = make("M6 6l8 8M14 6l-8 8");
export const WarningIcon = make("M10 3.2L17.6 16.4H2.4Z M10 8.2v3.6 M10 14.1h.01");
export const InfoIcon = make("M17.25 10a7.25 7.25 0 1 1-14.5 0a7.25 7.25 0 1 1 14.5 0Z M10 9.2v4.6 M10 6.5h.01");
export const PauseIcon = make("M7.5 5.5v9M12.5 5.5v9");
export const PlayIcon = make("M7 5.2v9.6L15 10Z");
export const ExternalIcon = make("M11.5 4.5h4v4M15.5 4.5L9.5 10.5M13.5 11.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3");
export const ArrowIcon = make("M4.5 10h11M11 5.5l4.5 4.5-4.5 4.5");
export const BackIcon = make("M15.5 10h-11M9 5.5L4.5 10 9 14.5");
export const CopyIcon = make("M8.5 7h6A1.5 1.5 0 0 1 16 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 7 14.5v-6A1.5 1.5 0 0 1 8.5 7Z M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7");
export const WalletIcon = make("M5 5.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z M17 8.5h-3.2a2 2 0 0 0 0 4H17 M13.9 10.5h.01");
export const ClockIcon = make("M17.25 10a7.25 7.25 0 1 1-14.5 0a7.25 7.25 0 1 1 14.5 0Z M10 6.2V10l2.6 1.8");
export const RefreshIcon = make("M15.6 10.6a5.7 5.7 0 1 1-1.7-4.6M14.6 3.6v3h-3");
export const ChevronIcon = make("M7.5 5l5 5-5 5");
export const ChevronDownIcon = make("M5 7.5l5 5 5-5");
