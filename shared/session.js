import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, authReady, db, isAdminUser } from "./firebase.js";

export async function currentAuthUser() {
  await authReady;
  return new Promise(resolve => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    });
  });
}

function currentReturnPath() {
  const path = `${location.pathname}${location.search}${location.hash}`;
  return path.startsWith("/") ? path : `/${path}`;
}

export async function requireClassSession(loginUrl) {
  const user = await currentAuthUser();
  if (!user) {
    location.replace(`${loginUrl}?returnTo=${encodeURIComponent(currentReturnPath())}`);
    return null;
  }

  let member = null;
  const profilePromise = getDoc(doc(db, "users", user.uid));
  if (!isAdminUser(user)) {
    const [memberSnapshot, profileSnapshot] = await Promise.all([
      getDoc(doc(db, "members", user.uid)),
      profilePromise
    ]);
    if (!memberSnapshot.exists()) {
      location.replace(`${loginUrl}?mode=join&returnTo=${encodeURIComponent(currentReturnPath())}`);
      return null;
    }
    member = memberSnapshot.data();
    if (member.blocked) {
      await signOut(auth);
      location.replace(`${loginUrl}?error=blocked`);
      return null;
    }
    const profile = profileSnapshot.exists()
      ? { uid: user.uid, ...profileSnapshot.data() }
      : { uid: user.uid, nickname: member.nickname || "Profil", photoData: null };
    return { user, member, profile, admin: false };
  }

  const profileSnapshot = await profilePromise;
  const profile = profileSnapshot.exists()
    ? { uid: user.uid, ...profileSnapshot.data() }
    : { uid: user.uid, nickname: "Elias", photoData: null };

  return { user, member, profile, admin: true };
}
