import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useFetcher } from 'react-router-dom';

import { type Request } from '../../../models/request';
import { Modal, type ModalHandle, type ModalProps } from '../base/modal';
import { ModalBody } from '../base/modal-body';
import { ModalFooter } from '../base/modal-footer';
import { ModalHeader } from '../base/modal-header';
import { AlertModal } from '../modals/alert-modal';
import { showModal } from '../modals/index';

export interface TestCase {
  uuid: string;
  id: string;
  test_suite_id: number;
  description: string;
  categories: string[];
  types: string[];
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    path_params: Record<string, string>;
    json_body: any;
  };
  fields: any[];
  sourceRequestId?: string;
}

interface State {
  request?: Request;
  isGenerating: boolean;
  error: string | null;
  testCases: TestCase[];
  folderId: string | null;
  machineId?: string;
  organizationId?: string;
  projectId?: string;
  workspaceId?: string;
}

export interface TestGeneratorModalOptions {
  request: Request;
  machineId: string;
  organizationId: string;
  projectId: string;
  workspaceId: string;
}

export interface TestGeneratorModalHandle {
  show: (options: TestGeneratorModalOptions) => void;
  hide: () => void;
}

export const TestGeneratorModal = forwardRef<TestGeneratorModalHandle, ModalProps>((props, ref) => {
  const modalRef = useRef<ModalHandle>(null);
  const folderFetcher = useFetcher();
  const requestFetcher = useFetcher();
  const abortControllerRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<State>({
    request: undefined,
    isGenerating: false,
    error: null,
    testCases: [],
    folderId: null,
  });

  const createRequest = useCallback(async (
    testCase: TestCase,
    folderId: string,
  ) => {
    if (!state.organizationId || !state.projectId || !state.workspaceId) {
      return;
    }

    const req: Partial<Request> = {
      url: testCase.request.url,
      method: testCase.request.method,
      headers: [],
      body: {},
      authentication: [],
      parameters: [],
      name: testCase.description,
      description: testCase.description,
    };

    if (Object.keys(testCase.request.json_body)?.length > 0 && (
      testCase.request.json_body['mimeType'] === 'application/json'
      && testCase.request.json_body['text']
    )) {
      req['body'] = testCase.request.json_body;
    } else {
      try {
        req['body'] = {
          'mimeType': 'application/json',
          'text': JSON.stringify(JSON.parse(testCase.request.json_body?.['text'])) ?? '',
        };
      } catch (error) {
        req['body'] = {
          'mimeType': 'application/json',
          'text': '',
        };
      }
    }

    if (Object.keys(testCase.request.headers)?.length > 0) {
      req['headers'] = Object.entries(testCase.request.headers).map(([name, value]) => ({
        name,
        value,
      }));
    }

    if (Object.keys(testCase.request.path_params)?.length > 0) {
      req['pathParameters'] = Object.entries(testCase.request.path_params).map(([name, value]) => ({
        name,
        value,
      }));
    }

    await requestFetcher.submit(
      JSON.stringify({ requestType: 'HTTP', parentId: folderId, req }),
      {
        encType: 'application/json',
        action: `/organization/${state.organizationId}/project/${state.projectId}/workspace/${state.workspaceId}/debug/request/new`,
        method: 'post',
      }
    );
  }, [state.organizationId, state.projectId, state.workspaceId, requestFetcher]);

  const generateTestCases = useCallback(async (request: Request, folderId: string) => {
    if (!state.machineId) {
      return;
    }
    abortControllerRef.current = new AbortController();

    const response = await fetch('https://be.kusho.ai/vscode/generate/streaming', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-KUSHO-SOURCE': 'insomnia',
      },
      body: JSON.stringify({
        machine_id: state.machineId,
        api_info: {
          method: request.method,
          url: request.url,
          headers: request.headers?.reduce((acc, h) => ({ ...acc, [h.name]: h.value }), {}),
          path_params: request.pathParameters?.reduce((acc, p) => ({ ...acc, [p.name]: p.value }), {}),
          json_body: JSON.parse(request.body?.['text'] ?? {}),
          api_desc: request.description,
        },
        test_suite_name: `${request.name} Tests`,
      }),
      signal: abortControllerRef.current.signal,
    });

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const testCase: TestCase = {
              ...JSON.parse(line.substring(5)),
              id: crypto.randomUUID(),
              sourceRequestId: request._id,
            };

            setState(prev => ({
              ...prev,
              testCases: [...prev.testCases, testCase],
            }));

            await createRequest(testCase, folderId);
          }
        }
      }
    } finally {
      reader.releaseLock();
      setState(prev => ({ ...prev, isGenerating: false }));
    }
  }, [state.machineId, createRequest]);

  const startTestGeneration = useCallback(async (request: Request) => {
    if (!state.organizationId || !state.projectId || !state.workspaceId) {
      return;
    }

    setState(prev => ({
      ...prev,
      isGenerating: true,
      error: null,
      testCases: [],
      folderId: null,
    }));

    try {
      await folderFetcher.submit(
        {
          parentId: request.parentId,
          name: `${request.name} Tests`,
        },
        {
          action: `/organization/${state.organizationId}/project/${state.projectId}/workspace/${state.workspaceId}/debug/request-group/new-response`,
          method: 'post',
        }
      );
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: 'Failed to create folder',
        isGenerating: false,
      }));
    }
  }, [folderFetcher, state.organizationId, state.projectId, state.workspaceId]);

  useEffect(() => {
    if (state.request && state.isGenerating && !state.folderId && folderFetcher.state === 'idle' && folderFetcher.data?.requestGroup?._id) {
      const folderId = folderFetcher.data.requestGroup._id;
      setState(prev => ({ ...prev, folderId }));

      generateTestCases(state.request, folderId).catch(err => {
        setState(prev => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Failed to generate tests',
          isGenerating: false,
        }));
      });
    }
  }, [folderFetcher.state, folderFetcher.data, state.request, state.isGenerating, state.folderId, generateTestCases]);

  useImperativeHandle(ref, () => ({
    hide: () => {
      abortControllerRef.current?.abort();
      modalRef.current?.hide();
      setState({
        request: undefined,
        isGenerating: false,
        error: null,
        testCases: [],
        folderId: null,
      });
    },
    show: ({ request, machineId, organizationId, projectId, workspaceId }) => {
      console.log('HERE');
      if (!request.url) {
        showModal(AlertModal, {
          title: 'Error',
          message: 'Cannot generate tests: No request data provided',
        });
        console.log('HERE1');
        return;
      }
      console.log('HERE2');
      setState(prev => ({
        ...prev,
        request,
        machineId,
        organizationId,
        projectId,
        workspaceId,
      }));
    },
  }), [state.isGenerating]);

  useEffect(() => {
    if (state.request && !state.isGenerating) {
      modalRef.current?.show();
      startTestGeneration(state.request);
    }
  }, [state.request, startTestGeneration]);

  const { request, isGenerating, error, testCases } = state;

  const renderStatus = () => {
    if (error) {
      return (
        <div className="notice error margin-bottom-sm">
          <div className="flex items-center">
            <i className="fa fa-warning pad-right-sm" />
            <span className="flex-1">{error}</span>
            <button className="icon" onClick={() => setState(prev => ({ ...prev, error: null }))}>
              <i className="fa fa-times" />
            </button>
          </div>
        </div>
      );
    }

    if (isGenerating) {
      return (
        <div className="notice info margin-bottom-sm">
          <div className="flex flex-col">
            <div className="flex items-center">
              <i className="fa fa-spinner fa-spin pad-right-sm" />
              {!state.folderId ? (
                <span>Creating test folder...</span>
              ) : (
                <span>Generating and creating test cases ({testCases.length} generated)...</span>
              )}
            </div>
            <div className="flex items-center mt-2">
              <span>Please Do not close this window. The Generation will also stop.</span>
            </div>
          </div>
        </div>
      );
    }
    if (testCases.length > 0) {
      return (
        <div className="notice success margin-bottom-sm">
          <div className="flex items-center">
            <i className="fa fa-check-circle pad-right-sm" />
            <span>Successfully generated {testCases.length} test cases</span>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <Modal ref={modalRef} tall {...props}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <i className="fa fa-flask" />
          Generate Tests for {request?.name}
        </div>
      </ModalHeader>
      <ModalBody className="pad">
        {renderStatus()}

        <div className="pad-sm bg-[--hl-xs] rounded margin-bottom-md">
          <h2 className="txt-lg flex items-center gap-2">
            <i className="fa fa-code" />
            Generated Test Cases
          </h2>
          <div className="txt-sm">Total: {testCases.length}</div>
        </div>

        {testCases.length > 0 ? (
          <div className="border rounded overflow-y-auto" style={{ minHeight: '500px' }}>
            {testCases.map(testCase => (
              <div key={testCase.uuid} className="pad-sm border-bottom">
                <div className="bold margin-bottom-sm">{testCase.description}</div>
                <div className="monospace txt-sm bg-[--hl-xs] pad-xs rounded">
                  <span className={`tag tag--${testCase.request.method.toLowerCase()}`}>
                    {testCase.request.method}
                  </span>
                  <span className="pad-left-sm">{testCase.request.url}</span>
                </div>
                <div className="flex gap-2 margin-top-sm flex-wrap">
                  {testCase.categories.map(category => (
                    <div key={category} className="tag tag--small">{category}</div>
                  ))}
                  {testCase.types.map(type => (
                    <div key={type} className="tag tag--small tag--secondary">{type}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center pad-lg bg-[--hl-xs] rounded">
            {isGenerating ? (
              <div>
                <i className="fa fa-spinner fa-spin fa-2x" />
                <div className="pad-top-sm txt-lg">Generating test cases...</div>
                <div className="txt-sm faint">Please wait while we create your tests</div>
              </div>
            ) : (
              <div className="faint">
                <i className="fa fa-flask fa-2x" />
                <div className="pad-top-sm">No test cases generated yet</div>
              </div>
            )}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <div className="italic txt-sm faint flex items-center gap-2">
          <i className="fa fa-info-circle" />
          Generated using KushoAI
        </div>
        <button
          className="btn"
          onClick={() => modalRef.current?.hide()}
          disabled={isGenerating}
        >
          {isGenerating ? (
            <>
              <i className="fa fa-spinner fa-spin pad-right-sm" />
              Generating...
            </>
          ) : 'Close'}
        </button>
      </ModalFooter>
    </Modal>
  );
});

TestGeneratorModal.displayName = 'TestGeneratorModal';
