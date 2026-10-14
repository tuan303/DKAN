import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { isSuperAdmin } from './adminAccess';
import { auth, db } from './firebase';

export type CurrentAccount = {
  uid: string;
  email: string;
  fullName: string;
  department: string;
  employeeId: string;
  initials: string;
  isSuperAdmin: boolean;
};

const textValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function accountFromUser(user: User, staff: Record<string, unknown> = {}): CurrentAccount {
  const [displayName = '', ...displayDepartment] = textValue(user.displayName).split('|').map(value => value.trim());
  const fullName = textValue(staff.fullName) || displayName;
  const email = textValue(user.email) || textValue(staff.email);
  const names = fullName.split(/\s+/).filter(Boolean);
  const initials = names.length > 1
    ? `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase()
    : (fullName || email).slice(0, 2).toUpperCase();

  return {
    uid: user.uid,
    email,
    fullName,
    department: textValue(staff.department) || displayDepartment.join(' | '),
    employeeId: textValue(staff.employeeId) || (typeof staff.employeeId === 'number' ? String(staff.employeeId) : ''),
    initials,
    isSuperAdmin: isSuperAdmin(user.email),
  };
}

/** Use the staff profile when available; discard reads from a previous auth session. */
export function useCurrentAccount(): CurrentAccount | null {
  const [account, setAccount] = useState<CurrentAccount | null>(null);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;
    const unsubscribe = onAuthStateChanged(auth, user => {
      const version = ++requestVersion;
      if (!active) return;
      setAccount(user ? accountFromUser(user) : null);
      if (!user) return;

      void getDoc(doc(db, 'staff', user.uid)).then(snapshot => {
        if (!active || version !== requestVersion || auth.currentUser?.uid !== user.uid) return;
        if (snapshot.exists()) setAccount(accountFromUser(user, snapshot.data()));
      }).catch(() => {
        // The authenticated identity remains usable when a profile cannot be read.
      });
    });

    return () => {
      active = false;
      requestVersion++;
      unsubscribe();
    };
  }, []);

  return account;
}
