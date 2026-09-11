// US equity session state, so the agent knows whether the underlying can
// currently reprice, and so after-hours information gets the weight it
// deserves. Tokens trade around the clock; the shares they track do not.
//
// Times are US Eastern. NYSE regular session 09:30-16:00, extended 04:00-09:30
// and 16:00-20:00, weekends closed. Holidays are not modelled: on a holiday
// the agent will believe the session is open when it is not, which costs a
// little optimism but never a wrong trade, since the premium guard still
// compares against Robinhood's live reference either way.

const ET = 'America/New_York';

export function sessionAt(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: ET, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false}).formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const wd = get('weekday'), h = Number(get('hour')) % 24, m = Number(get('minute'));
  const mins = h * 60 + m;
  const weekend = wd === 'Sat' || wd === 'Sun';
  let phase;
  if (weekend) phase = 'closed';
  else if (mins >= 570 && mins < 960) phase = 'regular';          // 09:30-16:00
  else if (mins >= 240 && mins < 570) phase = 'premarket';        // 04:00-09:30
  else if (mins >= 960 && mins < 1200) phase = 'afterhours';      // 16:00-20:00
  else phase = 'closed';
  // minutes until the next regular open
  let toOpen;
  if (phase === 'regular') toOpen = 0;
  else {
    const daysAhead = weekend ? (wd === 'Sat' ? 2 : 1) : (mins >= 570 ? 1 : 0);
    toOpen = daysAhead * 1440 + 570 - mins;
    if (wd === 'Fri' && mins >= 570) toOpen = 3 * 1440 + 570 - mins;
  }
  return {phase, weekend, minutesToOpen: toOpen, hoursToOpen: Number((toOpen / 60).toFixed(1)),
          underlyingCanTrade: phase === 'regular' || phase === 'premarket' || phase === 'afterhours',
          description: phase === 'regular' ? 'US regular session open'
            : phase === 'premarket' ? 'US pre-market, thin'
            : phase === 'afterhours' ? 'US after-hours, thin'
            : weekend ? 'US market closed for the weekend' : 'US market closed overnight'};
}
