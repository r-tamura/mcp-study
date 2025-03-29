import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

// 型定義
type JsonRpcRequest = {
	jsonrpc: string;
	id: number;
	method: string;
	params: Record<string, any>;
};

type JsonRpcNotification = {
	jsonrpc: string;
	method: string;
	params?: Record<string, any>;
};

type JsonRpcResponse = {
	jsonrpc: string;
	id: number;
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: any;
	};
};

// MCP Client クラス
class Client {
	private serverProcess: ChildProcessWithoutNullStreams | null = null;
	private nextRequestId = 1;
	private _responseHandlers: Map<number, (response: JsonRpcResponse) => void> =
		new Map();
	private isConnected = false;

	constructor() {
		// サーバープロセスは外部から渡されるのでここでは初期化しない
	}

	// サーバーとの接続を確立し、初期化フェーズを実行する
	public async connect(
		serverProcess: ChildProcessWithoutNullStreams,
	): Promise<void> {
		if (this.isConnected) {
			throw new Error("Client is already connected to a server");
		}

		this.serverProcess = serverProcess;
		console.log("Connecting to MCP server...");

		this.serverProcess.stdout.on("data", (data) =>
			this.handleServerOutput(data),
		);

		this.serverProcess.stderr.on("data", (data) => {
			console.error("Server Error:", data.toString().trim());
		});

		this.serverProcess.on("close", (code) => {
			console.log(`MCP server process exited with code ${code}`);
			this.isConnected = false;
			this.serverProcess = null;
		});

		// 初期化フェーズを実行
		await this.initialize();
		this.isConnected = true;

		return Promise.resolve();
	}

	// サーバーからの出力を処理
	private handleServerOutput(data: Buffer): void {
		const output = data.toString().trim();
		console.debug("Server output:", output);

		// JSONレスポンスを処理
		if (output.startsWith("{") && output.endsWith("}")) {
			try {
				const response = JSON.parse(output) as JsonRpcResponse;
				console.log("Parsed JSON response:", response);

				// コールバックが登録されていれば実行
				if (response.id && this._responseHandlers.has(response.id)) {
					const callback = this._responseHandlers.get(response.id);
					if (callback) {
						callback(response);
						this._responseHandlers.delete(response.id);
					}
				}
			} catch (error) {
				console.error("Error parsing JSON response:", error);
			}
		}
	}

	// JSONリクエストを送信
	private request(
		method: string,
		params: Record<string, any> = {},
	): Promise<any> {
		if (!this.serverProcess) {
			return Promise.reject(new Error("Not connected to a server"));
		}

		const id = this.nextRequestId++;

		return new Promise((resolve, reject) => {
			if (!this.serverProcess) {
				return Promise.reject(new Error("Not connected to a server"));
			}
			const request: JsonRpcRequest = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};

			console.log(`\nSending ${method} request...`);

			// コールバックを登録
			this._responseHandlers.set(id, (response) => {
				if (response.error) {
					reject(
						new Error(
							`Request failed: ${response.error.message} (${response.error.code})`,
						),
					);
				} else {
					resolve(response.result);
				}
			});

			// リクエストを送信
			this.serverProcess.stdin.write(JSON.stringify(request) + "\n");
		});
	}

	// 通知を送信
	private notification(
		method: string,
		params: Record<string, any> = {},
	): void {
		if (!this.serverProcess) {
			console.error("Cannot send notification: Not connected to a server");
			return;
		}

		const notification: JsonRpcNotification = {
			jsonrpc: "2.0",
			method,
			params,
		};

		console.log(`\nSending ${method} notification...`);
		this.serverProcess.stdin.write(JSON.stringify(notification) + "\n");
	}

	// MCPの初期化フェーズを実行
	private async initialize(): Promise<void> {
		try {
			// 初期化リクエストを送信
			const initParams = {
				protocolVersion: "2024-11-05",
				capabilities: {
					roots: {
						listChanged: true,
					},
					sampling: {},
				},
				clientInfo: {
					name: "MCPStudyClient",
					version: "1.0.0",
				},
			};

			const initResult = await this.request("initialize", initParams);

			// 初期化成功を表示
			console.log("\n======== MCP Initialization Successful ========");
			console.log(
				`Protocol Version: ${initResult.protocolVersion || "Not specified"}`,
			);

			if (initResult.capabilities) {
				console.log("\nServer Capabilities:");
				Object.keys(initResult.capabilities).forEach((capability) => {
					console.log(
						` - ${capability}: ${JSON.stringify(
							initResult.capabilities[capability],
						)}`,
					);
				});
			}

			if (initResult.serverInfo) {
				console.log("\nServer Info:");
				console.log(
					` - Name: ${initResult.serverInfo.name || "Not specified"}`,
				);
				console.log(
					` - Version: ${initResult.serverInfo.version || "Not specified"}`,
				);
			}

			// initialized通知を送信
			this.notification("notifications/initialized");
		} catch (error) {
			console.error("Initialization failed:", error);
			throw error;
		}
	}

	// ツール一覧を取得
	public async listTools(): Promise<any> {
		if (!this.isConnected) {
			return Promise.reject(new Error("Not connected to a server"));
		}

		try {
			const toolsResult = await this.request("tools/list", {});

			console.log("\n======== MCP Tools List ========");
			console.log(JSON.stringify(toolsResult, null, 2));
			console.log("==============================\n");

			return toolsResult;
		} catch (error) {
			console.error("Failed to fetch tools list:", error);
			throw error;
		}
	}

	// 接続を切断
	public disconnect(): void {
		console.log("\nDisconnecting from MCP server...");
		this.isConnected = false;
		this.serverProcess = null; // 外部管理のため、killしない
	}
}

// MCPサーバーのプロセスを作成する関数
function newServer(directories: string[]): ChildProcessWithoutNullStreams {
  // MCPサーバーのスクリプトパスを探す
  const findServerPath = (): string => {
    // ローカルのnode_modules内のパッケージを探す
    const packagePath = path.resolve(process.cwd(), 'node_modules', '@modelcontextprotocol', 'server-filesystem');

    if (fs.existsSync(packagePath)) {
      // package.jsonからメインスクリプトを取得
      const packageJsonPath = path.resolve(packagePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          const mainScript = packageJson.main || 'dist/index.js';
          return path.resolve(packagePath, mainScript);
        } catch (error) {
          console.error('Failed to parse package.json:', error);
        }
      }

      // デフォルトのパスを試す
      const defaultMainPath = path.resolve(packagePath, 'dist', 'index.js');
      if (fs.existsSync(defaultMainPath)) {
        return defaultMainPath;
      }
    }

    // 親のnode_modules内も確認
    const parentPackagePath = path.resolve(process.cwd(), '..', '..', 'node_modules', '@modelcontextprotocol', 'server-filesystem');

    if (fs.existsSync(parentPackagePath)) {
      const packageJsonPath = path.resolve(parentPackagePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          const mainScript = packageJson.main || 'dist/index.js';
          return path.resolve(parentPackagePath, mainScript);
        } catch (error) {
          console.error('Failed to parse package.json:', error);
        }
      }

      const defaultMainPath = path.resolve(parentPackagePath, 'dist', 'index.js');
      if (fs.existsSync(defaultMainPath)) {
        return defaultMainPath;
      }
    }

    throw new Error('Could not find @modelcontextprotocol/server-filesystem package');
  };

  const serverScriptPath = findServerPath();
  console.log(`Found server script at: ${serverScriptPath}`);

  // ディレクトリが指定されていない場合はカレントディレクトリを使用
  const dirs = directories.length > 0 ? directories : ['.'];
  console.log(`Using directories: ${dirs.join(', ')}`);

  const serverProcess = spawn(
    "node",
    [serverScriptPath, ...dirs],
    {
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  return serverProcess;
}

async function main() {
  // コマンドライン引数からディレクトリを取得
  // process.argv[0]: node実行ファイルのパス
  // process.argv[1]: 実行中のスクリプトのパス
  // process.argv[2]以降: ユーザーが指定した引数
  const [_node, _script, ...args] = process.argv;

  // "--" を除外して引数を取得
  const directories = args.filter(arg => arg !== '--');

  // サーバープロセスを作成
  const serverProcess = newServer(directories);
  const client = new Client();

  try {
    // サーバーに接続
    await client.connect(serverProcess);

    // ツール一覧を取得
    await client.listTools();

    // Ctrl+Cで終了するまで待機
    console.log("\nPress Ctrl+C to exit...");
  } catch (error) {
    console.error("Error:", error);
    // エラー発生時はプロセスを終了
    serverProcess.kill();
    process.exit(1);
  }

  // Ctrl+Cで終了時の処理
  process.on('SIGINT', () => {
    console.log('\nShutting down client and server...');
    client.disconnect();
    serverProcess.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Error in main function:", error);
  process.exit(1);
});