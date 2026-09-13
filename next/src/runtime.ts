import { randomUUID } from 'node:crypto';
import { Bots, type BotOptions } from './bots.js';
import { object, text } from './contract.js';
import { Conversation } from './conversation.js';
import { COPILOT_SELECTION, UnavailableProvider } from './copilot.js';
import { CanonicalRepository, type RepositoryOptions } from './repository.js';
import { SharedBrainstem, targetCapability, UnavailableBrainstem, type BrainstemBinding, type ModelProvider } from './spine.js';
import { NativeEstate, discoveryEvidence } from './estate.js';
import { RecurringWork } from './recurrence.js';
import { Collaboration } from './collaboration.js';
import { PrivateChannels, type PrivateChannelPort } from './channel.js';
import { ExternalActions, type ExternalEffectPort } from './effects.js';
import { LocalHive, type CanonicalHivePort } from './hive.js';
import { RootedEgg } from './egg.js';
import { Refusal, requireThat } from './errors.js';
import { AiProjectionApi } from './ai-api.js';

export interface RuntimeOptions extends RepositoryOptions {
  brainstem?: BrainstemBinding;
  provider?: ModelProvider;
  signers?: BotOptions['signers'];
  clock?: () => string;
  channel?: PrivateChannelPort;
  effects?: ExternalEffectPort;
  hive?: CanonicalHivePort;
  fixture?: boolean;
}

export class HeadlessRuntime {
  readonly conversation: Conversation;
  readonly estate: NativeEstate;
  readonly recurring: RecurringWork;
  readonly collaboration: Collaboration;
  readonly channels: PrivateChannels;
  readonly effects: ExternalActions;
  readonly hive: LocalHive;
  readonly egg: RootedEgg;
  readonly ai: AiProjectionApi;
  private constructor(readonly bots: Bots, readonly options: RuntimeOptions) {
    const provider = options.provider ?? new UnavailableProvider();
    this.conversation = new Conversation(bots, provider);
    this.estate = new NativeEstate(bots);
    this.recurring = new RecurringWork(bots);
    this.collaboration = new Collaboration(bots, provider);
    this.channels = new PrivateChannels(bots, this.conversation, options.channel);
    this.effects = new ExternalActions(bots, options.effects);
    this.hive = new LocalHive(bots, options.hive);
    this.egg = new RootedEgg(bots);
    this.ai = new AiProjectionApi(bots);
  }

  static async open(options: RuntimeOptions): Promise<HeadlessRuntime> {
    const repository = await CanonicalRepository.open({
      directory: options.directory,
      ...(options.signatures ? { signatures: options.signatures } : {}),
      ...(options.lockTimeoutMs ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
      ...(options.fault ? { fault: options.fault } : {}),
      ...(options.migrationFault ? { migrationFault: options.migrationFault } : {}),
    });
    const capability = await targetCapability();
    const spine = new SharedBrainstem(options.brainstem ?? new UnavailableBrainstem(), [capability]);
    const bots = new Bots({ repository, spine, capability: capability.reference,
      ...(options.signers ? { signers: options.signers } : {}), ...(options.clock ? { clock: options.clock } : {}) });
    return new HeadlessRuntime(bots, options);
  }

  async dispatch(method: string, value: unknown, operationId: string = randomUUID()): Promise<unknown> {
    const p = object(value);
    const check = (fields: readonly string[], optional: readonly string[] = []): void => { object(p, fields, optional); };
    const root = (): string => p.root === undefined ? this.bots.selected() : text(p.root, 260);
    switch (method) {
      case 'runtime.info':
        check([]);
        return { interface: 'rapp-work.stdio/1', projection: 'rapp-work.projection/1', model: COPILOT_SELECTION,
          fixture: this.options.fixture === true, signers: this.options.signers?.map(s => s.root) ?? [],
          externalBrainstemBound: this.options.brainstem?.available ?? false,
          iMessageEnabled: this.channels.port.available, nativeScanning: false, deletionApi: false, hostShell: false };
      case 'bots.create':
        check(['name'], ['keyedRoot']);
        return this.bots.create({ name: text(p.name, 120), operationId, ...(p.keyedRoot === undefined ? {} : { keyedRoot: text(p.keyedRoot, 260) }) });
      case 'bots.list':
        check([], ['includeHidden']);
        requireThat(p.includeHidden === undefined || typeof p.includeHidden === 'boolean', 'contract', 'includeHidden must be a boolean.');
        return this.bots.list(p.includeHidden === true);
      case 'bots.select':
        check(['root']);
        return this.bots.select(root());
      case 'bots.hide':
      case 'bots.restore':
        check([], ['root']);
        return this.bots.visibility(root(), method === 'bots.hide', operationId);
      case 'conversation.say':
        check(['text'], ['root', 'scope']);
        return this.conversation.converse(root(), text(p.text), operationId, p.scope === undefined ? 'root' : text(p.scope, 100));
      case 'conversation.where':
        check([], ['root']);
        return this.bots.whereWereWe(root());
      case 'attention.get':
        check([], ['root']);
        return { attention: (await this.bots.project(root())).attention, observation: this.bots.spine.status(root()) };
      case 'projection.get': {
        check([], ['root']);
        const projection = await this.bots.project(root());
        return { ...projection, turns: await this.collaboration.transcript(root()) };
      }
      case 'organization.confirm':
        check(['proposalWave'], ['root']);
        return this.conversation.confirm(root(), text(p.proposalWave, 64), operationId);
      case 'estate.record':
        check(['evidence'], ['root']);
        return this.estate.discover(root(), { discover: async () => discoveryEvidence(p.evidence) }, operationId);
      case 'estate.rapp-up':
        check([], ['root']);
        return this.conversation.converse(root(), 'RAPP Up: organize the explicitly discovered local native estate inside this one complete root world.', operationId);
      case 'work.progress':
        check(['scope', 'summary', 'evidence'], ['root']);
        return this.conversation.recordProgress(root(), text(p.scope, 100), text(p.summary, 2_000), p.evidence as string[], operationId);
      case 'work.undo':
        check(['targetWave', 'reason'], ['root']);
        return this.conversation.undo(root(), text(p.targetWave, 64), text(p.reason, 1_000), operationId);
      case 'work.due':
        check([], ['root', 'utc']);
        return this.recurring.due(root(), p.utc === undefined ? this.bots.now() : text(p.utc, 32));
      case 'work.tick':
        check(['routineId', 'occurrence'], ['root']);
        return this.recurring.tick(root(), text(p.routineId, 100), text(p.occurrence, 32));
      case 'collaboration.grant':
        check(['peer', 'publicBrief', 'mode'], ['root']);
        return this.collaboration.grant(root(), text(p.peer, 260), text(p.publicBrief, 2_000), p.mode as 'allow' | 'revoke', operationId);
      case 'collaboration.ask':
        check(['peer', 'question'], ['root']);
        return this.collaboration.ask(root(), text(p.peer, 260), text(p.question, 2_000), operationId);
      case 'collaboration.transcript':
        check([], ['root']);
        return this.collaboration.transcript(root());
      case 'effects.approve':
        check(['effectId', 'requestHash', 'target'], ['root']);
        return this.effects.approve(root(), text(p.effectId, 100), text(p.requestHash, 64), text(p.target, 200), operationId);
      case 'channels.bind':
        check(['contactRef', 'permissionRef', 'enabled'], ['root']);
        return this.channels.bind(root(), text(p.contactRef, 64), text(p.permissionRef, 64), p.enabled as boolean, operationId);
      case 'channels.queue-recap':
        check([], ['root']);
        return this.channels.queueRecap(root(), operationId);
      case 'channels.deliver':
        check(['deliveryId'], ['root']);
        return this.channels.deliver(root(), text(p.deliveryId, 64), operationId);
      case 'channels.recap':
        check([], ['root']);
        return this.channels.recap(root());
      case 'channels.receive':
        check(['envelope'], ['root']);
        return this.channels.receive(root(), p.envelope);
      case 'egg.at-rest':
        check([], ['root']);
        return this.egg.atRest(root());
      case 'egg.transfer':
        check(['operation', 'scope'], ['root']);
        return this.egg.transfer(root(), p.operation as 'inspect' | 'export' | 'restore', p.scope as 'godd' | 'dogg' | 'both');
      case 'hive.link':
        check(['peer', 'room', 'objectWave'], ['root']);
        return this.hive.link(root(), text(p.peer, 260), text(p.room, 100), text(p.objectWave, 64), operationId);
      case 'hive.consent':
        check(['peer', 'room', 'objectWave', 'mode'], ['root']);
        return this.hive.consent(root(), text(p.peer, 260), text(p.room, 100), text(p.objectWave, 64), p.mode as 'allow' | 'revoke', operationId);
      case 'clients.grant':
        check(['grant'], ['root']);
        return this.ai.authority.grant(root(), p.grant, operationId);
      case 'clients.revoke':
        check(['client', 'reason'], ['root']);
        return this.ai.authority.revoke(root(), text(p.client, 260), text(p.reason, 300), operationId);
      default:
        throw new Refusal('method-unavailable', 'No such headless method is authorized. There is no delete, host-shell, provider-switch or native-store-write API.');
    }
  }
}
