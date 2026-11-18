/* A searchable contact chooser for one client, with inline quick-create. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Plus, UserRound, UserRoundX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/common/misc'
import { contactsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { contactsQuery, ticketKeys } from '@/lib/api/queries'
import type { Contact } from '@/lib/api/types'
import { isEmail } from '@/lib/tickets/csv'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'

export interface ContactChoice {
  id: string
  name: string
  email: string
}

export function ContactPicker({
  clientId,
  siteId,
  value,
  onChange,
  disabled,
  id,
  className,
  align = 'start',
}: {
  clientId: string | null | undefined
  siteId?: string | null
  value: ContactChoice | null
  onChange: (contact: Contact | null) => void
  disabled?: boolean
  id?: string
  className?: string
  align?: 'start' | 'end'
}) {
  const me = useMe()
  const canCreate = hasPermission(me, PERMISSIONS.ticketsManage)
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const { data: contacts = [], isLoading } = useQuery({ ...contactsQuery(clientId ?? undefined), enabled: Boolean(clientId) && open })
  const needle = query.trim().toLowerCase()
  const visible = contacts.filter((contact) => !needle || [contact.name, contact.email, contact.phone, contact.title].some((field) => field.toLowerCase().includes(needle)))

  const create = useMutation({
    mutationFn: () =>
      contactsApi.create({
        client_id: clientId!,
        site_id: siteId ?? null,
        name: name.trim(),
        email: email.trim(),
        phone: '',
        title: '',
        is_primary: false,
        notify: true,
        notes: '',
      }),
    meta: { silent: true },
    onSuccess: (contact) => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.contacts })
      onChange(contact)
      setOpen(false)
      setCreating(false)
      setName('')
      setEmail('')
    },
  })
  const createError = create.error
    ? isApiError(create.error) && create.error.code === 'contact_exists'
      ? 'A contact with this email already exists for the client.'
      : errorMessage(create.error)
    : null
  const emailBad = email.trim() !== '' && !isEmail(email)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
          setCreating(false)
          create.reset()
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled || !clientId}
            className={cn('w-full justify-between gap-2 px-2.5 font-normal', className)}
          />
        }
      >
        {value ? (
          <span className="flex min-w-0 items-center gap-2">
            <UserAvatar name={value.name} size="xs" />
            <span className="truncate">{value.name}</span>
            {value.email && <span className="hidden truncate text-micro text-subtle-foreground sm:inline">{value.email}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-subtle-foreground">
            <UserRound className="size-3.5" />
            {clientId ? 'Choose a contact' : 'Choose a client first'}
          </span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0">
        {creating ? (
          <form
            className="grid gap-3 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim() || emailBad) return
              create.mutate()
            }}
          >
            <div className="text-dense font-medium">New contact</div>
            <label className="grid gap-1 text-micro text-muted-foreground">
              Name
              <Input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="Dana Reyes" />
            </label>
            <label className="grid gap-1 text-micro text-muted-foreground">
              Email
              <Input type="email" value={email} aria-invalid={emailBad || undefined} onChange={(event) => setEmail(event.target.value)} placeholder="dana@example.com" />
            </label>
            {createError && <p className="text-micro text-critical">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Back
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim() || emailBad || create.isPending}>
                {create.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                Create and select
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="border-b border-border p-2">
              <Input
                autoFocus
                value={query}
                placeholder="Search name, email or phone…"
                aria-label="Search contacts"
                className="h-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <ul className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label="Contacts">
              {isLoading ? (
                <li className="flex justify-center p-4">
                  <Spinner />
                </li>
              ) : visible.length === 0 ? (
                <li className="px-3 py-4 text-center text-dense text-muted-foreground">{contacts.length ? 'No contact matches.' : 'This client has no contacts yet.'}</li>
              ) : (
                visible.map((contact) => (
                  <li key={contact.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={value?.id === contact.id}
                      onClick={() => {
                        onChange(contact)
                        setOpen(false)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
                    >
                      <UserAvatar name={contact.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-dense font-medium">
                          {contact.name}
                          {contact.is_primary && <span className="ml-1.5 text-[10px] font-normal text-primary">Primary</span>}
                        </span>
                        <span className="block truncate text-micro text-muted-foreground">{[contact.email, contact.title, contact.site_name].filter(Boolean).join(' · ')}</span>
                      </span>
                      {value?.id === contact.id && <Check className="size-3.5 text-primary" />}
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex items-center gap-1 border-t border-border p-1">
              {canCreate && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="flex-1 justify-start"
                  onClick={() => {
                    setCreating(true)
                    if (query.includes('@')) setEmail(query.trim())
                    else setName(query.trim())
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {query.trim() ? `Create “${query.trim()}”` : 'New contact'}
                </Button>
              )}
              {value && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                >
                  <UserRoundX data-icon="inline-start" />
                  Clear
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
