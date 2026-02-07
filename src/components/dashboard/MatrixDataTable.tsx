import React, { useMemo, useState } from 'react'
import { cn } from '../../utils'

export interface TableColumn<T> {
  key: keyof T | string
  header: string
  width?: string
  align?: 'left' | 'center' | 'right'
  sortable?: boolean
  render?: (value: unknown, row: T, index: number) => React.ReactNode
}

export interface MatrixDataTableProps<T extends Record<string, unknown>> {
  data: T[]
  columns: TableColumn<T>[]
  keyField: keyof T
  sortable?: boolean
  defaultSort?: { key: string; direction: 'asc' | 'desc' }
  onRowClick?: (row: T) => void
  emptyMessage?: string
  maxHeight?: number | string
  striped?: boolean
  hoverable?: boolean
  compact?: boolean
  className?: string
}

export function MatrixDataTable<T extends Record<string, unknown>>({
  data,
  columns,
  keyField,
  sortable = true,
  defaultSort,
  onRowClick,
  emptyMessage = 'No data available',
  maxHeight,
  striped = true,
  hoverable = true,
  compact = false,
  className,
}: MatrixDataTableProps<T>) {
  const [sortConfig, setSortConfig] = useState<{
    key: string
    direction: 'asc' | 'desc'
  } | null>(defaultSort ?? null)

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortConfig) return data

    return [...data].sort((a, b) => {
      const aValue = a[sortConfig.key as keyof T]
      const bValue = b[sortConfig.key as keyof T]

      if (aValue === bValue) return 0
      
      const comparison = aValue < bValue ? -1 : 1
      return sortConfig.direction === 'asc' ? comparison : -comparison
    })
  }, [data, sortConfig])

  // Handle sort click
  const handleSort = (key: string) => {
    if (!sortable) return
    
    setSortConfig((current) => {
      if (current?.key !== key) {
        return { key, direction: 'asc' }
      }
      if (current.direction === 'asc') {
        return { key, direction: 'desc' }
      }
      return null
    })
  }

  // Get cell value
  const getCellValue = (row: T, column: TableColumn<T>, index: number) => {
    const value = row[column.key as keyof T]
    
    if (column.render) {
      return column.render(value, row, index)
    }
    
    if (value === null || value === undefined) return '-'
    if (typeof value === 'number') return value.toLocaleString()
    return String(value)
  }

  const paddingClass = compact ? 'px-3 py-2' : 'px-4 py-3'

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-matrix-border bg-matrix-card font-mono',
        className
      )}
    >
      <div
        className="overflow-auto"
        style={{ maxHeight: maxHeight ?? undefined }}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-matrix-bg">
            <tr className="border-b border-matrix-border">
              {columns.map((column) => (
                <th
                  key={String(column.key)}
                  className={cn(
                    'text-xs font-medium uppercase tracking-wider text-matrix-muted',
                    paddingClass,
                    column.align === 'center' && 'text-center',
                    column.align === 'right' && 'text-right',
                    sortable && column.sortable !== false && 'cursor-pointer select-none hover:text-matrix-primary'
                  )}
                  style={{ width: column.width }}
                  onClick={() => column.sortable !== false && handleSort(String(column.key))}
                >
                  <div className={cn(
                    'flex items-center gap-1',
                    column.align === 'center' && 'justify-center',
                    column.align === 'right' && 'justify-end'
                  )}>
                    {column.header}
                    {sortConfig?.key === column.key && (
                      <span className="text-matrix-primary">
                        {sortConfig.direction === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-8 text-center text-sm text-matrix-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              sortedData.map((row, index) => (
                <tr
                  key={String(row[keyField])}
                  className={cn(
                    'border-b border-matrix-border/50 transition-colors',
                    striped && index % 2 === 1 && 'bg-matrix-bg/30',
                    hoverable && 'hover:bg-matrix-primary/10',
                    onRowClick && 'cursor-pointer'
                  )}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map((column) => (
                    <td
                      key={String(column.key)}
                      className={cn(
                        'text-sm text-matrix-primary',
                        paddingClass,
                        column.align === 'center' && 'text-center',
                        column.align === 'right' && 'text-right'
                      )}
                    >
                      {getCellValue(row, column, index)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
