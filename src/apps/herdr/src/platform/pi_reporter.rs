//! Conservative ownership proof for the negotiated Pi session-report method.
//! Linux supports direct Pi and pi-profile -> direct Pi only; other platforms
//! deliberately return unknown until their ownership proof is implemented.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PiReporterIdentity {
    pub pid: u32,
    pub start_token: u64,
}

#[cfg(target_os = "linux")]
pub(crate) use super::linux::{
    pi_reporter_confirmed_gone as confirmed_gone, verify_pi_reporter as verify,
};

#[cfg(not(target_os = "linux"))]
pub(crate) fn verify(_shell_pid: u32, _reporter_pid: u32) -> Option<PiReporterIdentity> {
    None
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn confirmed_gone(_identity: PiReporterIdentity) -> bool {
    false
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn owns_job(job: &super::ForegroundJob, reporter_pid: u32, parent_pid: u32) -> bool {
    use crate::detect::{identify_agent, identify_agent_process_in_job, Agent};

    // Reject any job containing multiple Pi processes rather than relying on
    // the general detector's descendant scoring to choose one.
    let pi_processes: Vec<_> = job
        .processes
        .iter()
        .filter(|process| {
            let singleton = super::ForegroundJob {
                process_group_id: process.pid,
                processes: vec![(*process).clone()],
            };
            identify_agent_process_in_job(&singleton)
                .is_some_and(|(agent, _, _)| agent == Agent::Pi)
        })
        .collect();
    if pi_processes.len() != 1 || pi_processes[0].pid != reporter_pid {
        return false;
    }
    let Some(leader) = job.processes.iter().find(|p| p.pid == job.process_group_id) else {
        return false;
    };
    if reporter_pid == leader.pid {
        return identify_agent(&leader.name) == Some(Agent::Pi);
    }
    if parent_pid != leader.pid {
        return false;
    }

    // A single explicit pi-profile launcher may own one direct Pi child. Do
    // not match incidental command-line substrings or arbitrary descendants.
    let Some(argv) = leader.argv.as_ref() else {
        return false;
    };
    fn basename(value: &str) -> &str {
        std::path::Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
    }
    matches!(basename(&leader.name), "node" | "nodejs")
        && argv.len() >= 2
        && matches!(basename(&argv[0]), "node" | "nodejs")
        && basename(&argv[1]) == "pi-profile"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{ForegroundJob, ForegroundProcess};

    fn process(pid: u32, name: &str, argv: &[&str]) -> ForegroundProcess {
        ForegroundProcess {
            pid,
            name: name.into(),
            argv0: None,
            argv: Some(argv.iter().map(|value| (*value).into()).collect()),
            cmdline: None,
        }
    }

    #[test]
    fn exact_direct_or_profile_child_only() {
        let pi = process(20, "pi", &["pi"]);
        let direct = ForegroundJob {
            process_group_id: 20,
            processes: vec![pi.clone()],
        };
        assert!(owns_job(&direct, 20, 10));
        assert!(!owns_job(&direct, 99, 10));

        let launcher = process(10, "node", &["node", "/bin/pi-profile", "--continue"]);
        let mut wrapped = ForegroundJob {
            process_group_id: 10,
            processes: vec![launcher, pi],
        };
        assert!(owns_job(&wrapped, 20, 10));
        assert!(!owns_job(&wrapped, 20, 15));
        assert!(!owns_job(&wrapped, 10, 1));
        wrapped.processes.push(process(30, "pi", &["pi"]));
        assert!(!owns_job(&wrapped, 20, 10));
        assert!(!owns_job(&wrapped, 30, 20));
    }

    #[test]
    fn incidental_profile_argument_is_not_launcher_identity() {
        let job = ForegroundJob {
            process_group_id: 10,
            processes: vec![
                process(10, "node", &["node", "other.js", "pi-profile"]),
                process(20, "pi", &["pi"]),
            ],
        };
        assert!(!owns_job(&job, 20, 10));
    }
}
