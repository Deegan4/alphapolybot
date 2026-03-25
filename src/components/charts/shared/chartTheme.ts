// Matrix theme configuration for charts
export const matrixChartTheme = {
  colors: {
    primary: '#00ff00',
    secondary: '#ffa500',
    profit: '#00ff00',
    loss: '#ff0040',
    neutral: '#666666',
    grid: '#1a2f1a',
    background: '#0a0f0a',
    cardBg: '#0a0f0a',
    border: '#1a2f1a',
    text: '#00ff00',
    textMuted: '#00cc00',
  },
  fonts: {
    family: 'Geist Mono, monospace',
    size: {
      xs: 10,
      sm: 11,
      md: 12,
      lg: 14,
    },
  },
  glow: {
    primary: '0 0 10px rgba(0, 255, 0, 0.5)',
    secondary: '0 0 10px rgba(255, 165, 0, 0.5)',
    loss: '0 0 10px rgba(255, 0, 64, 0.5)',
  },
  gradients: {
    profit: {
      start: 'rgba(0, 255, 0, 0.3)',
      end: 'rgba(0, 255, 0, 0)',
    },
    loss: {
      start: 'rgba(255, 0, 64, 0.3)',
      end: 'rgba(255, 0, 64, 0)',
    },
  },
}

// Common chart props for consistent styling
export const defaultAxisProps = {
  stroke: matrixChartTheme.colors.grid,
  tick: { fill: matrixChartTheme.colors.textMuted, fontSize: matrixChartTheme.fonts.size.sm },
  tickLine: { stroke: matrixChartTheme.colors.grid },
  axisLine: { stroke: matrixChartTheme.colors.grid },
}

export const defaultGridProps = {
  stroke: matrixChartTheme.colors.grid,
  strokeDasharray: '3 3',
  strokeOpacity: 0.5,
}

export const defaultTooltipStyle = {
  backgroundColor: matrixChartTheme.colors.background,
  border: `1px solid ${matrixChartTheme.colors.border}`,
  borderRadius: '4px',
  fontFamily: matrixChartTheme.fonts.family,
  fontSize: matrixChartTheme.fonts.size.sm,
  color: matrixChartTheme.colors.text,
  boxShadow: matrixChartTheme.glow.primary,
}

export const defaultLegendStyle = {
  fontFamily: matrixChartTheme.fonts.family,
  fontSize: matrixChartTheme.fonts.size.sm,
}

// Utility to get color based on value (positive = profit, negative = loss)
export const getValueColor = (value: number): string => {
  if (value > 0) return matrixChartTheme.colors.profit
  if (value < 0) return matrixChartTheme.colors.loss
  return matrixChartTheme.colors.neutral
}

// Color palette for multiple data series
export const seriesColors = [
  '#00ff00', // Primary green
  '#ffa500', // Orange
  '#00ffff', // Cyan
  '#ff00ff', // Magenta
  '#ffff00', // Yellow
  '#00ff88', // Teal
]
