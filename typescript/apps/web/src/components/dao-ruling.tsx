import {
  daoProposalId,
  fetchProposalTransaction,
  type AppealView,
  type OracleEvent,
  type ProposalTransaction,
} from "@enzure/core";
import { useEffect, useState } from "react";
import { Account, TxLink } from "@/components/assertion-bits";
import { Badge } from "@/components/ui/badge";
import { config } from "@/config";
import { oracle } from "@/lib/oracle";

/**
 * The DAO's ruling on an Appeal: its outcome and the Sputnik DAO proposal
 * whose approval sent it, linked to the transaction that created the
 * proposal. The proposal is found from the `appeal_resolved` event's
 * transaction, so it shows once the events have loaded.
 */
export function DaoRulingDetail({
  outcome,
  appeal,
  events,
}: {
  outcome: boolean;
  appeal: AppealView;
  events: readonly OracleEvent[] | null;
}) {
  const [dao, setDao] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalTransaction | null>(null);
  const ruling = events?.find((event) => event.event === "appeal_resolved") ?? null;
  const proposalId = ruling && dao ? daoProposalId(ruling, dao) : null;

  useEffect(() => {
    let cancelled = false;
    oracle
      .getConfig()
      .then((found) => !cancelled && setDao(found.dao))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (proposalId === null || !ruling || !dao) return;
    let cancelled = false;
    fetchProposalTransaction(
      { apiUrl: config.txApiUrl, contractId: dao },
      { proposalId, sinceNs: appeal.started_at_ns, maxBlockHeight: ruling.blockHeight },
    )
      .then((found) => !cancelled && setProposal(found))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [proposalId, ruling?.transactionHash, dao, appeal.started_at_ns]);

  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={outcome ? "default" : "destructive"}>{outcome ? "TRUE" : "FALSE"}</Badge>
        {dao ? (
          <span>
            by <Account id={dao} />
          </span>
        ) : null}
      </span>
      {proposalId !== null ? (
        <span>
          Proposal {proposalId}
          {proposal ? (
            <>
              {proposal.description ? <>: &ldquo;{proposal.description}&rdquo;</> : null}, proposed
              by <Account id={proposal.proposer} /> in <TxLink hash={proposal.transactionHash} />
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
