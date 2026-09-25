import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

describe('AppShell', () => {
  it('shows the OPS FLOW brand and sends navigation selections to its parent', () => {
    const onNavigate = vi.fn()
    render(
      <AppShell
        activePage="dashboard"
        navigationItems={[
          { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
          { id: 'production', label: 'Production', icon: 'factory' },
        ]}
        onNavigate={onNavigate}
        operationalWeek="Week 39"
      >
        <p>Operational content</p>
      </AppShell>,
    )

    expect(screen.getByText('OPS FLOW')).toBeInTheDocument()
    expect(screen.getByText('Operational Week 39')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))
    expect(onNavigate).toHaveBeenCalledWith('production')
  })
})
