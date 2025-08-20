// Shared Google Play Android Publisher client
import { google } from 'googleapis';

let androidpublisher = null;

export function getAndroidPublisher() {
  if (androidpublisher) return androidpublisher;

  
  const creds = process.env.GOOGLE_SA_JSON
    ? JSON.parse(process.env.GOOGLE_SA_JSON)
    : null;

  const auth = new google.auth.GoogleAuth({
    credentials: creds || undefined,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  androidpublisher = google.androidpublisher({ version: 'v3', auth });
  return androidpublisher;
}
