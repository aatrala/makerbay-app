import { Route } from 'react-router-dom'
import type { DashboardModule } from '@makerbay/web-kit'
import ContactDetail from './ContactDetail'
import ContactsList from './ContactsList'

/**
 * Contacts is core, so the shell mounts it for every workspace regardless of
 * entitlements. Modules that each kept their own customer list could never be
 * joined up afterwards, which is why this one is never switched off.
 */
export const contactsDashboard: DashboardModule = {
  id: 'contacts',
  label: 'Contacts',
  nav: [{ to: '/contacts', label: 'All contacts' }],
  routes: () => (
    <>
      <Route path="/contacts" element={<ContactsList />} />
      <Route path="/contacts/:contactId" element={<ContactDetail />} />
    </>
  ),
}

export default contactsDashboard
export type { Contact } from './ContactsList'
