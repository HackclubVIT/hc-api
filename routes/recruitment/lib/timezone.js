/**
 * Centralized Timezone Utilities for Asia/Kolkata (IST)
 */

const RECRUITMENT_TIMEZONE = "Asia/Kolkata";

export function getISTDateBounds(dateString) {
  const now = new Date();
  
  const istString = dateString
    ? new Date(dateString).toLocaleString("en-US", { timeZone: RECRUITMENT_TIMEZONE })
    : now.toLocaleString("en-US", { timeZone: RECRUITMENT_TIMEZONE });
    
  const istDate = new Date(istString);
  
  const year = istDate.getFullYear();
  const month = istDate.getMonth();
  const day = istDate.getDate();
  
  // IST is UTC+5:30 (5.5 hours)
  const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - (5.5 * 60 * 60 * 1000));
  const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));
  const endOfWeek = new Date(endOfDay.getTime() + 7 * 86400000);
  
  return { startOfDay, endOfDay, endOfWeek };
}

export function toISTDateString(date) {
  return new Date(date).toLocaleString("en-CA", { 
    timeZone: RECRUITMENT_TIMEZONE, 
    year: "numeric", 
    month: "2-digit", 
    day: "2-digit" 
  });
}

export function toISTTimeString(date) {
  return new Date(date).toLocaleTimeString("en-GB", {
    timeZone: RECRUITMENT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function parseISTDateToUTC(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  
  // Create UTC date assuming IST (UTC - 5.5 hours)
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - (5.5 * 60 * 60 * 1000));
}
