//! Optional Discord Rich Presence ("Playing <game>" / "on <console>").
//! Talks to the local Discord client over IPC; needs a Discord application ID.
//! Runs on its own thread because connecting can block.

use discord_rich_presence::activity::{Activity, ActivityType, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use std::sync::mpsc::{channel, Sender};

pub type StatusSink = Box<dyn Fn(String) + Send>;

enum Cmd {
    Set { client_id: String, game: String, console: String, start_ms: i64 },
    Clear,
}

pub struct Presence {
    tx: Sender<Cmd>,
}

impl Presence {
    pub fn new(status: StatusSink) -> Self {
        let (tx, rx) = channel::<Cmd>();
        std::thread::Builder::new()
            .name("discord-rpc".into())
            .spawn(move || {
                let mut client: Option<(String, DiscordIpcClient)> = None;
                while let Ok(mut cmd) = rx.recv() {
                    // Only the latest request matters (Discord rate-limits updates).
                    while let Ok(newer) = rx.try_recv() {
                        cmd = newer;
                    }
                    match cmd {
                        Cmd::Clear => {
                            if let Some((_, mut c)) = client.take() {
                                let _ = c.clear_activity();
                                let _ = c.close();
                            }
                            status("Off".into());
                        }
                        Cmd::Set { client_id, game, console, start_ms } => {
                            if client.as_ref().map(|(id, _)| id != &client_id).unwrap_or(true) {
                                if let Some((_, mut c)) = client.take() {
                                    let _ = c.close();
                                }
                                let mut c = DiscordIpcClient::new(&client_id);
                                if let Err(e) = c.connect() {
                                    status(format!("Can't reach Discord ({e}). Is it running?"));
                                    continue;
                                }
                                client = Some((client_id, c));
                            }
                            let (_, c) = client.as_mut().unwrap();
                            // Without `name`, Discord's profile card reads "Playing <application
                            // name>" (whatever the user called the app in the developer portal).
                            // Recent Discord builds take `name` as an override, so the card reads
                            // "Playing <game>". Builds that ignore it still show the game in the
                            // member list, through `details` + StatusDisplayType::Details.
                            let title = if game.is_empty() { &console } else { &game };
                            let mut act = Activity::new()
                                .name(title.as_str())
                                .activity_type(ActivityType::Playing)
                                .status_display_type(StatusDisplayType::Details)
                                .timestamps(Timestamps::new().start(start_ms));
                            if !game.is_empty() {
                                act = act.details(&game);
                            }
                            if !console.is_empty() {
                                act = act.state(format!("on {console}"));
                            }
                            let res = c.set_activity(act.clone()).or_else(|_| {
                                c.reconnect()?;
                                c.set_activity(act)
                            });
                            match res {
                                Ok(()) => status("Connected".into()),
                                Err(e) => {
                                    status(format!("Discord update failed: {e}"));
                                    client = None;
                                }
                            }
                        }
                    }
                }
            })
            .expect("spawn discord thread");
        Self { tx }
    }

    pub fn set(&self, client_id: String, game: String, console: String, start_ms: i64) {
        let _ = self.tx.send(Cmd::Set { client_id, game, console, start_ms });
    }

    pub fn clear(&self) {
        let _ = self.tx.send(Cmd::Clear);
    }
}
