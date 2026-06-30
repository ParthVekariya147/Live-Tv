import { getMessaging, getToken, onMessage } from 'firebase/messaging'
import { firebaseApp } from '../firebase-config.js'

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY
const PERMISSION_KEY = 'fcm_permission_status'
const TOKEN_KEY = 'fcm_token'

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

export async function initFCM() {
    if (!isSupported()) {
        console.info('[FCM] Push notifications not supported in this browser')
        return
    }

    // Don't re-init if already denied
    if (Notification.permission === 'denied') {
        localStorage.setItem(PERMISSION_KEY, 'denied')
        return
    }

    // Don't re-init if already registered and granted
    const existingToken = localStorage.getItem(TOKEN_KEY)
    if (existingToken && Notification.permission === 'granted') {
        const messaging = getMessaging(firebaseApp)
        setupForegroundHandler(messaging)
        return
    }

    // Register service worker
    let swReg
    try {
        swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' })
    } catch (err) {
        console.warn('[FCM] Service worker registration failed:', err)
        return
    }

    // Request browser permission
    const permission = await Notification.requestPermission()
    localStorage.setItem(PERMISSION_KEY, permission)

    if (permission !== 'granted') return

    const messaging = getMessaging(firebaseApp)

    // Get FCM token with retry
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
                return
            }
            await new Promise(r => setTimeout(r, attempt * 1000))
        }
    }

    if (!token) return

    localStorage.setItem(TOKEN_KEY, token)
    await registerTokenWithServer(token)

    setupForegroundHandler(messaging)
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
