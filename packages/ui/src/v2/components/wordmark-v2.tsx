import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <rect x="8" y="24" width="81" height="81" rx="20" fill="#b0662a" />
          <path
            d="M68 49H43a6 6 0 0 0-6 6v19a6 6 0 0 0 6 6h25"
            stroke="#fff"
            stroke-width="9"
            stroke-linecap="round"
            fill="none"
          />
          <text
            x="112"
            y="94"
            font-family="'Segoe UI', system-ui, -apple-system, sans-serif"
            font-size="72"
            font-weight="800"
            letter-spacing="-2"
            fill="currentColor"
            opacity="0.7"
          >
            corro code
          </text>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
