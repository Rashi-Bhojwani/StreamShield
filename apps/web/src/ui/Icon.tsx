import type { CSSProperties } from "react";
const paths = {
  home: "m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9",
  live: "M5 7a7 7 0 0 0 0 10M19 7a7 7 0 0 1 0 10M8 10a3 3 0 0 0 0 4M16 10a3 3 0 0 1 0 4M12 11v2",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  chevron: "m9 5 7 7-7 7",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  user: "M20 21v-2a7 7 0 0 0-14 0v2M17 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  heart:
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8",
  studio: "M3 5h12v14H3zM15 9l6-4v14l-6-4",
  shield: "M12 2 21 6v6c0 5-5 8-9 10-4-2-9-5-9-10V6l9-4Zm-4 10 3 3 5-6",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  chat: "M21 11a9 9 0 0 1-9 9H4l-3 2 2-7a9 9 0 1 1 18-4ZM7 10h10M7 14h6",
  clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3",
  play: "m8 4 13 8-13 8V4Z",
  share: "M12 16V3m-5 5 5-5 5 5M4 13v8h16v-8",
  lock: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4",
  spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z",
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  className = "",
  style,
}: {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={"icon " + className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
