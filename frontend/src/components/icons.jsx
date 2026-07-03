import React from 'react'

// Icônes œil (trait, hérite de la couleur du texte) — remplacent les emojis.
const base = (size) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
  strokeLinejoin: 'round', 'aria-hidden': true,
  style: { verticalAlign: '-2px' },
})

export const Eye = ({ size = 15 }) => (
  <svg {...base(size)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const Refund = ({ size = 15 }) => (
  <svg {...base(size)}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
)

export const Check = ({ size = 15 }) => (
  <svg {...base(size)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

export const Sun = ({ size = 15 }) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
)

export const Moon = ({ size = 15 }) => (
  <svg {...base(size)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

export const Download = ({ size = 15 }) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

export const EyeOff = ({ size = 15 }) => (
  <svg {...base(size)}>
    <path d="M17.94 17.94A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.06-4.94" />
    <path d="M9.9 5.24A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.16 3.19" />
    <path d="M10.12 10.12a3 3 0 1 0 4.24 4.24" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
)
