import { getMessaging, getToken, onMessage } from 'firebase/messaging'
import { firebaseApp } from '../firebase-config.js'

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY
const PERMISSION_KEY = 'fcm_permission_status'
const TOKEN_KEY = 'fcm_token'
const HEARTBEAT_MS = 6 * 60 * 60 * 1000 // 6h — long-lived tabs need a periodic re-ping too

function isSupported() {
    return (
        'PushManager' in window &&
        'Notification' in window &&
        'serviceWorker' in navigator
    )
}

function getBrowserName() {
    const ua = navigator.userAgent
    if (ua.includes('Edg/')) return 'Edge'
    if (ua.includes('Chrome/')) return 'Chrome'
    if (ua.includes('Firefox/')) return 'Firefox'
    if (ua.includes('Safari/')) return 'Safari'
    return 'Browser'
}

async function registerTokenWithServer(token) {
    try {
        await fetch('/api/notifications/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token,
                deviceName: `${getBrowserName()} on ${navigator.platform || 'Unknown'}`,
                userAgent: navigator.userAgent,
            }),
        })
    } catch (err) {
        console.warn('[FCM] Token registration request failed:', err)
    }
}

function setupForegroundHandler(messaging) {
    onMessage(messaging, (payload) => {
        const { title, body, icon } = payload.notification || {}
        if (Notification.permission === 'granted' && title) {
            new Notification(title, {
                body: body || '',
                icon: icon || '/icon-192.png',
                badge: '/icon-192.png',
            })
        }
    })
}

// Fetches a token (fresh or reused by the SDK) and always re-registers it with
// the server. Re-registering unconditionally — even when the token string is
// unchanged — is what keeps `lastSeenAt` alive server-side and catches silent
// token rotation. The previous version skipped this whenever a cached token
// already existed, so `lastSeenAt` was written once at first registration and
// never again — devices looked "registered" forever while actually being dead.
async function refreshAndRegister(messaging, swReg) {
    let token = null
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            token = await getToken(messaging, {
                vapidKey: VAPID_KEY,
                serviceWorkerRegistration: swReg,
            })
            break
        } catch (err) {
            if (attempt === 3) {
                console.warn('[FCM] Token fetch failed after 3 attempts:', err)
                return null
            }
            await new Promise(r => setTimeout(r, attempt * 1000))
        }
    }
    if (!token) return null

    localStorage.setItem(TOKEN_KEY, token)
    await registerTokenWithServer(token)
    return token
}

function startHeartbeat(messaging, swReg) {
    if (window.__fcmHeartbeatStarted) return
    window.__fcmHeartbeatStarted = true
    setInterval(() => { refreshAndRegister(messaging, swReg) }, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshAndRegister(messaging, swReg)
    })
    window.addEventListener('online', () => { refreshAndRegister(messaging, swReg) })
}

// Called automatically on every app load. This must NEVER call
// Notification.requestPermission() itself — Chrome (and other browsers)
// permanently auto-blocks a site from ever showing the permission prompt
// again once it decides requests are happening without a genuine user
// gesture and are being ignored/dismissed too often. That's exactly what
// silently kills notifications after they "worked for a while": once the
// origin crosses that threshold, permission flips to 'denied' forever with
// no popup, and no in-page code can undo it — only the user clearing the
// site's permission manually can. So auto-init only ever does the *silent*
// parts (SW registration, token refresh/re-registration, heartbeat) for a
// device that has already explicitly granted permission. Asking for
// permission in the first place is requestNotificationPermission()'s job,
// and that must only ever be invoked from a real click handler.
export async function initFCM() {
    if (!isSupported()) {
        console.info('[FCM] Push notifications not supported in this browser')
        return
    }

    localStorage.setItem(PERMISSION_KEY, Notification.permission)
    if (Notification.permission !== 'granted') return

    let swReg
    try {
        swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' })
    } catch (err) {
        console.warn('[FCM] Service worker registration failed:', err)
        return
    }

    const messaging = getMessaging(firebaseApp)
    setupForegroundHandler(messaging)
    await refreshAndRegister(messaging, swReg)
    startHeartbeat(messaging, swReg)
}

// Must only be called from a genuine user gesture (a click/tap handler) —
// this is what's allowed to actually show the permission prompt.
export async function requestNotificationPermission() {
    if (!isSupported()) return 'unsupported'
    if (Notification.permission === 'denied') return 'denied'

    let swReg
    try {
        swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' })
    } catch (err) {
        console.warn('[FCM] Service worker registration failed:', err)
        return 'error'
    }

    const permission = await Notification.requestPermission()
    localStorage.setItem(PERMISSION_KEY, permission)
    if (permission !== 'granted') return permission

    const messaging = getMessaging(firebaseApp)
    setupForegroundHandler(messaging)
    await refreshAndRegister(messaging, swReg)
    startHeartbeat(messaging, swReg)
    return 'granted'
}

export async function unregisterFCM() {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) return
    try {
        await fetch('/api/notifications/register', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        })
    } catch (_) {}
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(PERMISSION_KEY)
}

export function getFCMStatus() {
    return {
        supported: isSupported(),
        permission: 'Notification' in window ? Notification.permission : 'unsupported',
        token: localStorage.getItem(TOKEN_KEY),
    }
}
