import * as React from "react";

const KEY = "lumibot-ui-privacy";

/** Privacy mode blurs every element marked `.sensitive` (amounts, balances). */
export function usePrivacy(): [boolean, () => void] {
  const [on, setOn] = React.useState(() => localStorage.getItem(KEY) === "1");
  React.useEffect(() => {
    document.documentElement.classList.toggle("privacy", on);
    localStorage.setItem(KEY, on ? "1" : "0");
  }, [on]);
  return [on, () => setOn((v) => !v)];
}
