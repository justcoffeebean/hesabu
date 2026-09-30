/**
 * Who can do what, in one place.
 *
 *   owner     everything, including team, settings, integrations and M-Pesa refunds
 *   accounts  the money: clients, items, invoices, payments, recurring, reminders, imports, audit log
 *   staff     the floor: jobs, quotations, stock counts, and asking a customer to pay by M-Pesa
 */
const ROLES = ['owner', 'accounts', 'staff'];
const ALL = ROLES;
const MONEY = ['owner', 'accounts'];

const PERMISSIONS = {
  'dashboard:read': ALL,
  'clients:read': ALL,
  'clients:write': MONEY,
  'items:read': ALL,
  'items:write': MONEY,
  'stock:adjust': ALL,
  'quotations:read': ALL,
  'quotations:write': ALL,
  'invoices:read': ALL,
  'invoices:write': MONEY,
  'invoices:send': MONEY,
  'payments:read': MONEY,
  'payments:write': MONEY,
  'mpesa:request': ALL,
  'mpesa:refund': ['owner'], // money leaving the business
  'recurring:read': MONEY,
  'recurring:write': MONEY,
  'reminders:read': MONEY,
  'reminders:write': ['owner'],
  'tasks:read': ALL,
  'tasks:write': ALL,
  'settings:read': ALL,
  'settings:write': ['owner'],
  'currencies:write': MONEY,
  'users:manage': ['owner'],
  'audit:read': MONEY,
  'import:run': MONEY
};

const can = (user, permission) => Boolean(user && user.active && (PERMISSIONS[permission] || []).includes(user.role));

const permissionsFor = (role) => Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));

module.exports = { ROLES, PERMISSIONS, can, permissionsFor };
