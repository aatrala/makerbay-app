import { authEmail, CODE_PLACEHOLDER, type AuthKind } from '@makerbay/email'

/**
 * Every code email Cognito sends, rendered by our own templates.
 *
 * The user pool's `userVerification` property only covers sign-up. Password
 * reset, resend, attribute verification and the MFA code all ignore it, so
 * without this trigger the single most sensitive email in the product - the
 * one carrying a credential that can take over a workspace - arrived as
 * Cognito's unstyled default: no explanation, no warning about phone calls
 * asking for the code, and nothing tying it visually to the mail a
 * tradesperson already recognises from us.
 *
 * That inconsistency is not cosmetic. A reset code that looks nothing like
 * every other MakerBay email is one a careful person cannot tell from a
 * forgery, and one a careless person learns to accept from anybody.
 *
 * `emailMessage` and `emailSubject` are only honoured because the pool sends
 * through SES (EmailSendingAccount DEVELOPER). On a COGNITO_DEFAULT pool
 * returning them is a 400 InvalidLambdaResponseException, so if mail sending
 * is ever moved back off SES this trigger must come off with it.
 */

interface CustomMessageEvent {
  triggerSource: string
  request: {
    /** Cognito's own placeholder. Substituted for the real code after we return. */
    codeParameter?: string
    usernameParameter?: string
    userAttributes?: Record<string, string>
  }
  response: {
    smsMessage?: string
    emailMessage?: string
    emailSubject?: string
  }
}

/**
 * Which of our three templates each event wants.
 *
 * `AdminCreateUser` is deliberately absent. It needs the username as well as
 * the code, and a template that silently dropped it would send an invitation
 * nobody can act on. Returning nothing for it leaves Cognito's default in
 * place, which is worse looking but correct - and we do not admin-create
 * users in this pool anyway.
 */
const KIND: Record<string, AuthKind> = {
  CustomMessage_SignUp: 'verify',
  CustomMessage_ResendCode: 'verify',
  CustomMessage_VerifyUserAttribute: 'verify',
  CustomMessage_UpdateUserAttribute: 'verify',
  CustomMessage_ForgotPassword: 'reset',
  CustomMessage_Authentication: 'signin',
}

/** SMS has 140 characters including the code, so it gets its own line, not a truncated email. */
const smsFor = (kind: AuthKind, code: string): string =>
  kind === 'reset'
    ? `${code} is your MakerBay reset code. MakerBay will never ring you asking for it.`
    : `${code} is your MakerBay code. MakerBay will never ring you asking for it.`

export const handler = async (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
  const kind = KIND[event.triggerSource]
  if (!kind) return event

  // Use the placeholder Cognito handed us rather than assuming '{####}'. It is
  // documented as the value to substitute, and hardcoding it would break
  // silently - the email would render with a literal {####} where the code
  // belongs and every affected person would be locked out.
  const code = event.request.codeParameter ?? CODE_PLACEHOLDER
  const mail = authEmail(kind)
  const swap = (s: string) => s.split(CODE_PLACEHOLDER).join(code)

  event.response.emailSubject = swap(mail.subject)
  event.response.emailMessage = swap(mail.html)
  event.response.smsMessage = smsFor(kind, code)
  return event
}
